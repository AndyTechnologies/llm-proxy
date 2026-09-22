<script lang="ts">
  import {
    parseConditionSource,
    renderConditionSource,
  } from "../../lib/workflow-condition.js";
  import { nodeTypeDef } from "../../lib/workflow-nodes.js";
  import type { NodeFieldDef } from "../../lib/workflow-nodes.js";
  import type { FlowNode, FlowNodeData } from "../../lib/workflow-flow.js";
  import { sanitizeAst } from "../../../../src/orchestrator/graph.js";

  /**
   * Editable inspector panel (U06): per-type form for the selected canvas
   * node. Writes are IMMEDIATE canvas updates through `onUpdate(id, patch)`
   * — nothing auto-saves; persistence is the explicit Save in FlowEditor.
   *
   * Layout per taxonomy:
   *   - start/end/output        → read-only summary (structural nodes)
   *   - fan/join                → connection-driven guidance (edges only)
   *   - llm_call                → generic fields; model gets a local-registry
   *                               datalist; on_429 / tool_calls_route get
   *                               target warnings (NOT blockers)
   *   - condition / router      → canonical condition source editor (grammar
   *                               mirrors the backend SAFE AST; valid input
   *                               writes the opaque AST slot)
   *   - loop                    → iterations number + body multi-select
   *                               (existing node ids, start/end excluded)
   *   - pipeline                → pipeline name + editable params key/value rows
   *   - rag_local / memory /
   *     embeddings / data.code  → generic fields (k, convId, text, code)
   */

  let {
    node,
    onUpdate,
    canvasNodes,
    knownModelIds,
  }: {
    node: FlowNode | null;
    onUpdate: (id: string, patch: Partial<FlowNodeData>) => void;
    canvasNodes: readonly FlowNode[];
    knownModelIds: readonly string[];
  } = $props();

  const entry = $derived(node === null ? null : workflowNodeTypes(node.data.wNodeType));
  const readOnlyType = $derived(
    node !== null &&
      (node.data.wNodeType === "start" ||
        node.data.wNodeType === "end" ||
        node.data.wNodeType === "output"),
  );
  const connectionDriven = $derived(
    node !== null &&
      (node.data.wNodeType === "fan" || node.data.wNodeType === "join"),
  );

  // ── Generic field rendering ────────────────────────────────────────────────

  /** The primitive value an input should show for a field ("", "2", …). */
  function displayValue(field: NodeFieldDef): string {
    if (node === null) return "";
    const value = node.data.values[field.key];
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    return String(value);
  }

  /** Is there a current (non-empty) value for this field? */
  function hasValue(field: NodeFieldDef): boolean {
    if (node === null) return false;
    const value = node.data.values[field.key];
    return value !== undefined && value !== "";
  }

  /** Engine-required fields gain a hint when unset. */
  function requiredNote(field: NodeFieldDef): boolean {
    return node?.data.wNodeType === "llm_call" && field.key === "model";
  }

  /**
   * Convert raw input text to the value shape the field's kind admits — the
   * UI twin of `sanitizeFieldValue`. Empty/invalid → undefined → the key is
   * dropped from values (same "unknown/dropped" admission as the backend).
   */
  function cleanFieldValue(
    field: NodeFieldDef,
    raw: string,
  ): string | number | boolean | undefined {
    switch (field.kind) {
      case "toggle":
        return undefined; // handled by writeToggle
      case "number": {
        if (raw === "") return undefined;
        const num = Number(raw);
        return Number.isFinite(num) ? num : undefined;
      }
      case "tokens": {
        if (raw === "") return undefined;
        const num = Number(raw);
        return Number.isFinite(num) ? num : raw;
      }
      case "select":
        return field.options?.includes(raw) ? raw : undefined;
      case "textarea":
      case "text":
      case "code":
        return raw === "" ? undefined : raw;
    }
  }

  /** Generic-kind write: sanitize to the admission shape, then persist. */
  function writeField(field: NodeFieldDef, raw: string): void {
    if (node === null) return;
    const values = { ...node.data.values };
    const cleaned = cleanFieldValue(field, raw);
    if (cleaned === undefined) delete values[field.key];
    else values[field.key] = cleaned;
    onUpdate(node.id, { values });
  }

  function writeToggle(field: NodeFieldDef, checked: boolean): void {
    if (node === null) return;
    const values = { ...node.data.values };
    if (!checked) delete values[field.key];
    else values[field.key] = checked;
    onUpdate(node.id, { values });
  }

  /** Input id for label association (unique per selected node). */
  function fieldInputId(field: NodeFieldDef): string {
    return node === null ? field.key : `wf-${node.id}-${field.key}`;
  }

  /** Warning (not blocker) for route targets referencing unknown ids. */
  function targetNote(field: NodeFieldDef): string | null {
    if (node === null) return null;
    const value = node.data.values[field.key];
    if (typeof value !== "string" || value === "") return null;
    if (canvasNodes.some((other) => other.id === value)) return null;
    return `"${value}" is not an existing node id — saved graphs require a real target.`;
  }

  // ── Loop body multi-select ─────────────────────────────────────────────────

  const bodyCandidates = $derived(
    node === null
      ? []
      : canvasNodes.filter(
          (other) =>
            other.id !== node.id &&
            other.data.wNodeType !== "start" &&
            other.data.wNodeType !== "end",
        ),
  );

  const bodySelection = $derived(
    node !== null && Array.isArray(node.data.values.body)
      ? (node.data.values.body as string[])
      : [],
  );

  function toggleBodyMember(memberId: string): void {
    if (node === null) return;
    const current = Array.isArray(node.data.values.body) ? [...node.data.values.body] : [];
    const idx = current.indexOf(memberId);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(memberId);
    onUpdate(node.id, { values: { ...node.data.values, body: current } });
  }

  // ── Condition source editor (condition / router) ───────────────────────────

  const conditionActive = $derived(
    node !== null &&
      (node.data.wNodeType === "condition" || node.data.wNodeType === "router"),
  );

  /** Local draft so invalid typing is never clobbered by the canonical form. */
  let conditionDraft = $state("");

  /** Re-sync the draft whenever the node (or its stored AST) changes. */
  $effect(() => {
    if (!conditionActive) return;
    conditionDraft =
      node!.data.condition !== undefined ? renderConditionSource(node!.data.condition) : "";
  });

  const conditionError = $derived.by(() => {
    if (!conditionActive || conditionDraft.trim() === "") return null;
    const parsed = parseConditionSource(conditionDraft);
    return parsed.ok ? null : parsed.error;
  });

  function onConditionInput(event: Event): void {
    if (node === null || !conditionActive) return;
    const draft = (event.currentTarget as HTMLTextAreaElement).value;
    conditionDraft = draft;
    if (draft.trim() === "") {
      onUpdate(node.id, { condition: undefined });
      return;
    }
    const parsed = parseConditionSource(draft);
    if (!parsed.ok) return;
    if (sanitizeAst(parsed.expr) === null) return; // backend authority gate
    onUpdate(node.id, { condition: parsed.expr });
  }

  // ── Pipeline params editor ─────────────────────────────────────────────────

  interface ParamRow {
    key: string;
    value: string;
  }

  let paramsRows = $state<ParamRow[]>([]);

  $effect(() => {
    const params = node?.data.params;
    const keys = params !== undefined ? Object.keys(params) : [];
    paramsRows =
      keys.length === 0
        ? [{ key: "", value: "" }]
        : keys.map((key) => ({ key, value: params[key] }));
  });

  function pushParams(rows: readonly ParamRow[]): void {
    if (node === null) return;
    const params: Record<string, string> = {};
    for (const row of rows) {
      if (row.key.trim() !== "") params[row.key.trim()] = row.value;
    }
    onUpdate(node.id, { params });
  }

  function writeParam(row: ParamRow, patch: Partial<ParamRow>): void {
    const rows = paramsRows.map((r) => (r === row ? { ...r, ...patch } : r));
    paramsRows = rows;
    pushParams(rows);
  }

  function addParamRow(): void {
    paramsRows = [...paramsRows, { key: "", value: "" }];
  }

  function removeParamRow(row: ParamRow): void {
    const rows = paramsRows.filter((r) => r !== row);
    paramsRows = rows.length === 0 ? [{ key: "", value: "" }] : rows;
    pushParams(rows);
  }
</script>

<aside class="inspector" aria-label="Node inspector">
  <h2 class="panel-title">Inspector</h2>

  {#if node === null}
    <p class="inspector-empty">Select a node to edit its fields.</p>
  {:else if entry === null}
    <p class="inspector-empty">Unknown node type.</p>
  {:else}
    <div class="inspector-head">
      <span class="inspector-chip" style={`background: var(--${entry.color});`} aria-hidden="true"></span>
      <div class="inspector-id">
        <strong class="inspector-label">{node.data.label}</strong>
        <code class="inspector-type">{node.data.wNodeType}</code>
      </div>
    </div>
    <p class="inspector-desc">{entry.description}</p>
    <code class="inspector-node-id">{node.id}</code>

    {#if readOnlyType}
      <section class="inspector-section" aria-label="Fields">
        <h3 class="inspector-sub">No editable fields</h3>
        <p class="inspector-muted">This node is structural — the graph engine reads it as-is.</p>
      </section>
    {:else if connectionDriven}
      <section class="inspector-section" aria-label="Connections">
        <h3 class="inspector-sub">Connection-driven</h3>
        <p class="inspector-muted">
          {node.data.wNodeType === "fan"
            ? "Branches are the edges leaving this node — connect several targets to fan out in parallel."
            : "Merge happens through incoming edges — connect branch outputs here before the graph continues."}
        </p>
      </section>
    {:else}
      {#if node.data.wNodeType === "condition" || node.data.wNodeType === "router"}
        <section class="inspector-section" aria-label="Condition">
          <h3 class="inspector-sub">Condition</h3>
          <label class="field-label" for={`wf-${node.id}-condition`}>Expression</label>
          <textarea
            id={`wf-${node.id}-condition`}
            class="field-input field-code"
            rows={4}
            spellcheck="false"
            value={conditionDraft}
            oninput={onConditionInput}
          ></textarea>
          {#if conditionError !== null}
            <p class="field-error" role="alert">{conditionError}</p>
          {:else if conditionDraft.trim() !== ""}
            <p class="field-note field-note-ok" aria-live="polite">Expression accepted by the engine.</p>
          {/if}
          <p class="field-hint">
            Operators: exists(field), not(…), all(…), any(…), field ==/!=/&lt;/&lt;=/&gt;/&gt;= value.
            Fields: lastResponse.status, lastResponse.content, error, variables.*.
            Values: numbers, "strings", true/false/null.
          </p>
        </section>
      {:else if node.data.wNodeType === "loop"}
        <section class="inspector-section" aria-label="Iterations">
          <h3 class="inspector-sub">Iterations</h3>
          {#each entry.fields as field (field.key)}
            {#if field.key === "iterations"}
              <div class="field">
                <label class="field-label" for={fieldInputId(field)}>{field.label}</label>
                <input
                  id={fieldInputId(field)}
                  class="field-input"
                  type="number"
                  min="1"
                  step="1"
                  value={displayValue(field)}
                  oninput={(event) => writeField(field, (event.currentTarget as HTMLInputElement).value)}
                />
              </div>
            {/if}
          {/each}
        </section>
        <section class="inspector-section" aria-label="Body">
          <h3 class="inspector-sub">Body</h3>
          {#if bodyCandidates.length === 0}
            <p class="inspector-muted">Add other nodes to the canvas to fill the loop body.</p>
          {:else}
            <ul class="body-list">
              {#each bodyCandidates as other (other.id)}
                <li>
                  <label class="body-option">
                    <input
                      type="checkbox"
                      checked={bodySelection.includes(other.id)}
                      onchange={() => toggleBodyMember(other.id)}
                    />
                    <span class="body-option-id">{other.id}</span>
                    <code class="body-option-type">{other.data.wNodeType}</code>
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {:else if node.data.wNodeType === "pipeline"}
        <section class="inspector-section" aria-label="Pipeline">
          <h3 class="inspector-sub">Pipeline</h3>
          {#each entry.fields as field (field.key)}
            {#if field.key === "pipeline"}
              <div class="field">
                <label class="field-label" for={fieldInputId(field)}>{field.label}</label>
                <input
                  id={fieldInputId(field)}
                  class="field-input"
                  type="text"
                  placeholder={field.placeholder}
                  value={displayValue(field)}
                  oninput={(event) => writeField(field, (event.currentTarget as HTMLInputElement).value)}
                />
              </div>
            {/if}
          {/each}
          <h3 class="inspector-sub inspector-sub-gap">Params</h3>
          {#each paramsRows as row, i (i)}
            <div class="param-row">
              <input
                class="field-input field-input-key"
                type="text"
                placeholder="key"
                aria-label="Parameter key"
                value={row.key}
                oninput={(event) => writeParam(row, { key: (event.currentTarget as HTMLInputElement).value })}
              />
              <input
                class="field-input"
                type="text"
                placeholder="value"
                aria-label="Parameter value"
                value={row.value}
                oninput={(event) => writeParam(row, { value: (event.currentTarget as HTMLInputElement).value })}
              />
              <button
                class="param-remove"
                type="button"
                aria-label={`Remove parameter ${row.key === "" ? "" : row.key}`}
                onclick={() => removeParamRow(row)}
              >
                ×
              </button>
            </div>
          {/each}
          <button class="param-add" type="button" onclick={addParamRow}>Add parameter</button>
        </section>
      {:else}
        <section class="inspector-section" aria-label="Fields">
          <h3 class="inspector-sub">Fields</h3>
          {#each entry.fields as field (field.key)}
            <div class="field">
              <label class="field-label" for={fieldInputId(field)}>
                {field.label}
                {#if requiredNote(field) && !hasValue(field)}
                  <span class="required-note">required</span>
                {/if}
              </label>

              {#if field.kind === "select"}
                <select
                  id={fieldInputId(field)}
                  class="field-input"
                  value={displayValue(field)}
                  onchange={(event) => writeField(field, (event.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="">Unset</option>
                  {#each field.options ?? [] as option (option)}
                    <option value={option}>{option}</option>
                  {/each}
                </select>
              {:else if field.kind === "toggle"}
                <input
                  id={fieldInputId(field)}
                  class="field-toggle"
                  type="checkbox"
                  checked={node.data.values[field.key] === true}
                  onchange={(event) => writeToggle(field, (event.currentTarget as HTMLInputElement).checked)}
                />
              {:else if field.kind === "textarea" || field.kind === "code"}
                <textarea
                  id={fieldInputId(field)}
                  class="field-input"
                  class:field-code={field.kind === "code"}
                  rows={field.kind === "code" ? 6 : 3}
                  spellcheck={field.kind !== "code"}
                  placeholder={field.placeholder}
                  value={displayValue(field)}
                  oninput={(event) => writeField(field, (event.currentTarget as HTMLTextAreaElement).value)}
                ></textarea>
              {:else}
                <input
                  id={fieldInputId(field)}
                  class="field-input"
                  type={field.kind === "number" ? "number" : "text"}
                  step={field.kind === "number" ? "any" : undefined}
                  inputmode={field.kind === "tokens" ? "decimal" : undefined}
                  placeholder={field.placeholder}
                  value={displayValue(field)}
                  list={field.key === "model" ? "wf-model-suggestions" : undefined}
                  oninput={(event) => writeField(field, (event.currentTarget as HTMLInputElement).value)}
                />
              {/if}

              {#if field.key === "model"}
                <p class="field-hint">Local registry ids ({knownModelIds.length} {knownModelIds.length === 1 ? "model" : "models"}).</p>
              {/if}
              {#if (field.key === "on_429" || field.key === "tool_calls_route") && targetNote(field) !== null}
                <p class="field-warning" role="note">{targetNote(field)}</p>
              {/if}
            </div>
          {/each}
        </section>
      {/if}
    {/if}
  {/if}
</aside>

<datalist id="wf-model-suggestions">
  {#each knownModelIds as id (id)}
    <option value={id}></option>
  {/each}
</datalist>

<style>
  .panel-title {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--text);
  }

  .inspector {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
    overflow-y: auto;
  }

  .inspector-empty {
    margin: 0;
    color: var(--secondary);
    font-size: 0.82rem;
    line-height: 1.5;
  }

  .inspector-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .inspector-chip {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: var(--radius-full);
  }

  .inspector-id {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .inspector-label {
    font-size: 0.92rem;
    font-weight: 700;
    line-height: 1.25;
  }

  .inspector-type {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.7rem;
  }

  .inspector-desc {
    margin: 0;
    color: var(--secondary);
    font-size: 0.8rem;
    line-height: 1.5;
  }

  .inspector-node-id {
    align-self: flex-start;
    max-width: 100%;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--secondary);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .inspector-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .inspector-sub {
    margin: 0;
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }

  .inspector-sub-gap {
    margin-top: var(--space-2);
  }

  .inspector-muted {
    margin: 0;
    color: var(--muted);
    font-size: 0.78rem;
    line-height: 1.5;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .field-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--secondary);
    font-size: 0.74rem;
    font-weight: 600;
    line-height: 1.4;
  }

  .required-note {
    color: var(--danger);
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .field-input {
    width: 100%;
    min-width: 0;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 0.78rem;
    line-height: 1.5;
    box-sizing: border-box;
  }

  .field-input::placeholder {
    color: var(--muted);
  }

  select.field-input {
    appearance: none;
  }

  .field-code {
    font-family: var(--font-mono);
    font-size: 0.74rem;
    resize: vertical;
  }

  .field-hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.5;
  }

  .field-warning {
    margin: 0;
    color: var(--danger);
    font-size: 0.7rem;
    line-height: 1.5;
  }

  .field-error {
    margin: 0;
    color: var(--danger);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    line-height: 1.45;
  }

  .field-note-ok {
    color: var(--success);
  }

  .body-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .body-option {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    cursor: pointer;
  }

  .body-option-id {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.76rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .body-option-type {
    margin-left: auto;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.66rem;
  }

  .param-row {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: var(--space-2);
    align-items: center;
  }

  .field-input-key {
    font-family: var(--font-mono);
    font-size: 0.72rem;
  }

  .param-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--code);
    color: var(--secondary);
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
  }

  .param-remove:hover {
    color: var(--danger);
    border-color: var(--border-hover);
  }

  .param-add {
    align-self: flex-start;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--card);
    color: var(--secondary);
    font-size: 0.74rem;
    cursor: pointer;
  }

  .param-add:hover {
    color: var(--text);
    border-color: var(--border-hover);
  }
</style>
<script lang="ts">
  import { astSummary, type FlowNode, type FlowNodeData } from "../../lib/workflow-flow.js";
  import { formatValue, nodeTypeDef } from "../../lib/workflow-nodes.js";
  import type { NodeFieldDef } from "../../lib/workflow-nodes.js";

  /**
   * Read-only inspector panel (U05) for the selected canvas node: identity,
   * taxonomy description, the same summary lines the card shows, and the
   * full per-type field surface from the taxonomy (values or "—"). Editable
   * forms arrive in U06; this establishes the panel seam.
   */

  let { node }: { node: FlowNode | null } = $props();

  const entry = $derived(node === null ? null : nodeTypeDef(node.data.wNodeType));
  const lines = $derived(node === null ? [] : summaryLines(node.data));

  function summaryLines(data: FlowNodeData): { key: string; value: string }[] {
    const out: { key: string; value: string }[] = [];
    if (data.wNodeType === "condition" || data.wNodeType === "router") {
      out.push({
        key: "condition",
        value: data.condition !== undefined ? astSummary(data.condition) : "unset",
      });
      return out;
    }
    if (data.wNodeType === "pipeline" && data.params !== undefined) {
      for (const [key, value] of Object.entries(data.params)) {
        out.push({ key, value });
      }
      return out;
    }
    return out;
  }

  function fieldValue(field: NodeFieldDef, data: FlowNodeData): string {
    if (field.key === "condition") {
      return data.condition !== undefined ? astSummary(data.condition) : "unset";
    }
    return formatValue(field.kind, data.values[field.key]);
  }

  /** Engine-required fields render a "required" hint when unset. */
  function isRequired(field: NodeFieldDef, data: FlowNodeData): boolean {
    return data.wNodeType === "llm_call" && field.key === "model";
  }

  function hasOpaqueSlots(data: FlowNodeData): boolean {
    return data.condition !== undefined || data.params !== undefined;
  }
</script>

<aside class="inspector" aria-label="Node inspector">
  <h2 class="panel-title">Inspector</h2>

  {#if node === null}
    <p class="inspector-empty">Select a node to inspect its fields.</p>
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

    {#if lines.length > 0}
      <section class="inspector-section" aria-label="Summary">
        <h3 class="inspector-sub">Summary</h3>
        <dl class="inspector-rows">
          {#each lines as line (line.key)}
            <div class="inspector-row">
              <dt>{line.key}</dt>
              <dd>{line.value}</dd>
            </div>
          {/each}
        </dl>
      </section>
    {/if}

    <section class="inspector-section" aria-label="Fields">
      <h3 class="inspector-sub">
        {entry.fields.length > 0 || hasOpaqueSlots(node.data) ? "Fields" : "No fields"}
      </h3>
      {#if entry.fields.length > 0 || hasOpaqueSlots(node.data)}
        <dl class="inspector-rows">
          {#each entry.fields as field (field.key)}
            {#if field.key !== "condition" || node.data.condition !== undefined}
              <div class="inspector-row">
                <dt>{field.label}</dt>
                <dd class:unset={!isRequired(field, node.data) && fieldValue(field, node.data) === "—"}>
                  {fieldValue(field, node.data)}
                  {#if isRequired(field, node.data) && fieldValue(field, node.data) === "—"}
                    <span class="required-note">required</span>
                  {/if}
                </dd>
              </div>
            {/if}
          {/each}
        </dl>
      {:else}
        <p class="inspector-muted">This node type has no editable fields.</p>
      {/if}
    </section>
  {/if}
</aside>

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

  .inspector-rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
  }

  .inspector-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .inspector-row dt {
    flex: none;
    min-width: 96px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.72rem;
  }

  .inspector-row dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--secondary);
    font-family: var(--font-mono);
    font-size: 0.76rem;
  }

  .inspector-row dd.unset {
    color: var(--muted);
  }

  .required-note {
    color: var(--danger);
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .inspector-muted {
    margin: 0;
    color: var(--muted);
    font-size: 0.78rem;
  }
</style>
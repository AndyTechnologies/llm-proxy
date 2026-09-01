# Design: Fix LLM Proxy Bugs

## Technical Approach

Minimal, self-contained point fixes across `pipelines.js` and `utils/micro.js`, one per bug, each independently revertable. No new dependencies, no test runner (strict_tdd: false), no requirement changes — this is a non-regression implementation (spec: `proxy-pipeline`). Each fix restores expected OpenAI-compatible behavior that regressed. Runtime verification via `node --check` + manual smoke tests.

## Architecture Decisions

| Decision | Option | Tradeoff | Choice |
|---|---|---|---|
| Bug 1 — declare `finishReasonRecibido` | (a) module/global var | leaks into module scope, mutable cross-request | **local `let` in `runPipelineStream` scope** |
| | (b) local `let` near top of function | correct scope, no leakage | selected |
| Bug 3 — single terminal in catch | (a) keep `enviarChunkFinal()` + errorPayload | two terminals → contradictory, corrupts SSE for `[DONE]`-parsers | **call `enviarChunkFinal()` once, drop errorPayload** |
| | (b) single error-bearing terminal chunk | preserves error text but diverges from `stop` convention | rejected (see rationale) |
| Bug 4 — NaN-safe numbers | (a) `<number>\|\| fallback` | `0`/`""`/`"0"` falsey → wrong defaults | **`finiteNumber()` helper with explicit guards** |
| | (b) `finiteNumber(value, fallback, min, max)` | handles NaN/Infinity/null/"" and clamps | selected |
| Bug 2 — restoration | (a) exact commented block | misses plain-string parts in arrays | **extend to string parts + empty-array graceful** |
| | (b) extended normalization | still non-regression, covers spec scenario | selected |

### Decision: Bug 1 — local boolean

**Choice**: `let finishReasonRecibido = false;` at the top of `runPipelineStream`, replacing the commented `//let upstreamFinished = false;` (line 100).
**Alternatives**: module/global scope variable.
**Rationale**: `finishReasonRecibido` is used as a boolean (`if (finishReasonRecibido)`, log string at line 178) within this single function's flow (loop + post-loop + catch). A local declaration starts at `false`, is set `true` when a streamed chunk carries `finish_reason`, and prevents the `ReferenceError` that breaks the whole stream. No module/global state leaks across requests this way.

### Decision: Bug 3 — exactly one terminal chunk

**Choice**: In the `catch` block, replace the body with a single `enviarChunkFinal()` call and delete the `errorPayload` block (lines 193–211).
**Alternatives**: emit one terminal error chunk (`finish_reason: null` + `error.message`).
**Rationale**: `enviarChunkFinal()` already guards `res.writableEnded`, writes the final chunk + `[DONE]`, then `res.end()`. Writing a second `errorPayload` (finish_reason `null`) after it is a contradictory duplicate terminal that most SSE clients stop reading at `[DONE]`, producing wasted bytes and a malformed/overwritten stream. The invariant requires "exactly one terminal SSE chunk, no contradictory error payload follows." The error is still surfaced via `console.log`/the thrown error's caller; preserving the message in-band is a future enhancement, not a regression fix. A single clean `finish_reason: "stop"` terminal preserves client compatibility.

### Decision: Bug 4 — `finiteNumber` helper

**Choice**: Add `finiteNumber(value, fallback, min, max)` in `utils/micro.js`; apply to `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`.
**Rationale**: `Math.max(0, Math.min(2, Number("abc")))` yields `NaN` because NaN comparisons are falsey and propagate. The helper pre-guards `null`/`""`/`undefined` and `!Number.isFinite(n)` (covers NaN/±Infinity) before clamping, so every path returns a finite default-then-clamp value.

## Data Flow

```
Client ──> runPipelineStream(pipelines.js)
             ├─ pre-stages (non-stream) ──> execPipe
             └─ last stage: llamaChatStream ──> iterator
                  │  finish_reason? → finishReasonRecibido=true
                  │  no finish_reason → enviarChunkFinal()  [chunk + [DONE] + end]
                  └─ catch(err): enviarChunkFinal() ONCE     [no errorPayload]

Request ──> sanitizePayloadForLlamaCpp(utils/micro.js)
             ├─ developer→system  + array→scalar content   (Bug 2)
             └─ temperature/top_p/max_tokens via finiteNumber (Bug 4)
                  ──> clean payload ──> llama.cpp
```

## File Changes

| File | Action | Description |
|---|---|---|
| `pipelines.js` | Modify | Bug 1: declare `finishReasonRecibido` (line 100). Bug 3: catch calls `enviarChunkFinal()` once, remove errorPayload block. |
| `utils/micro.js` | Modify | Bug 2: uncomment + extend normalization. Bug 4: add `finiteNumber` helper and apply to params. |

## Interfaces / Contracts

Bug 1 (pipelines.js, line ~100):

```js
let finishReasonRecibido = false; // Bug 1
```

Bug 3 (pipelines.js catch, lines 188–214):

```js
} catch (err) {
  if (!res.writableEnded) {
    console.error(`[orchestrator] Error en streaming: ${err}`);
    enviarChunkFinal(); // single terminal; no duplicate errorPayload
  }
}
```

Bug 4 (utils/micro.js, new helper + applied) — non-obvious pattern:

```js
function finiteNumber(value, fallback, min, max) {
  if (value === null || value === "" || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback; // NaN, ±Infinity
  return Math.min(max, Math.max(min, n));
}
// in sanitizePayloadForLlamaCpp:
if (payload.temperature !== undefined) clean.temperature = finiteNumber(payload.temperature, 0.7, 0, 2);
if (payload.top_p !== undefined) clean.top_p = finiteNumber(payload.top_p, 1, 0, 1);
if (payload.max_tokens !== undefined) clean.max_tokens = finiteNumber(payload.max_tokens, 2048, 1, 8192);
if (payload.max_completion_tokens !== undefined) {
  clean.max_tokens = finiteNumber(payload.max_completion_tokens, 2048, 1, 8192);
}
```

Bug 2 (utils/micro.js normalization, replaces commented block):

```js
if (Array.isArray(clean.messages)) {
  clean.messages = clean.messages.map((msg) => {
    let next = { ...msg };
    if (next.role === "developer") next.role = "system";
    if (Array.isArray(next.content)) {
      const textParts = next.content
        .map((p) =>
          typeof p === "string"
            ? p
            : p && p.type === "text" && typeof p.text === "string"
              ? p.text
              : null
        )
        .filter((t) => t !== null);
      next.content = textParts.join("\n"); // "" for empty/no-text arrays
    }
    return next;
  });
}
```

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Static | Syntax of both files | `node --check pipelines.js`, `node --check utils/micro.js` |
| Unit (no runner) | `finiteNumber` edge cases | Node one-liner/`node -e`: NaN, null, `""`, `0`, negative, fractional, `Infinity` |
| Unit (no runner) | normalization | `node -e` against `sanitizePayloadForLlamaCpp`: developer→system, array→scalar, array with plain-string parts, empty array, string content untouched |
| Integration | Streaming no ReferenceError | manual smoke: `/v1/chat/completions` with `stream: true` completes with `[DONE]`, no crash |
| Integration | Catch single terminal | force upstream error mid-stream → exactly one terminal chunk, no second errorPayload |

Testing is manual + `node -e` / `node --check` because no test runner exists (per `openspec/config.yaml`).

## Threat Matrix

N/A — no routing, shell command, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary is changed. Pure in-process JS bug fixes.

## Migration / Rollout

No migration required. Each bug is an independent commit, individually `git revert`-able (per proposal *Rollback Plan*).

## Open Questions

- [ ] Confirm fallback defaults for `temperature` (0.7), `top_p` (1), `max_tokens` (2048) — implementation detail, not contract; adjust if a workspace default exists.

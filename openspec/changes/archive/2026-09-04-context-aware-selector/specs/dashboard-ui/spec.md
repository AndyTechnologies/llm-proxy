# Dashboard UI — Delta Spec

Modifies: `openspec/specs/dashboard-ui/spec.md`

## MODIFIED Requirements

### Requirement: Execution and model inspection

The SPA SHALL display executions and models via the `/api/ui/*` endpoints and update live through the SSE events bus (execution progress, `pipeline:reloaded`, `models:changed`). The model inspection view SHALL render GGUF metadata (`ggufContextLength`, `hardwareMaxCtx`) per model. The pipeline editor's context window selector SHALL dynamically filter options using the selected model's `ggufContextLength` and `hardwareMaxCtx` instead of a hardcoded list, and SHALL visually indicate when a selected context exceeds the safe range.
(Previously: model inspection showed basic id/file/loaded; context selector used hardcoded `CONTEXT_STANDARDS` array)

#### Scenario: Execution progress updates live

- GIVEN the SPA is subscribed to SSE and an execution starts
- WHEN `step:*` events arrive
- THEN the executions view updates to reflect the current step and status

#### Scenario: Model list refreshes on models:changed

- GIVEN the SPA has loaded the model list
- WHEN a `models:changed` SSE event arrives
- THEN the model list refreshes to include the newly detected or registered models

#### Scenario: Context selector filtered by GGUF metadata

- GIVEN a model with `ggufContextLength: 8192` and `hardwareMaxCtx: 16384`
- WHEN the user selects that model in the pipeline editor
- THEN the context window selector shows only options up to `min(ggufContextLength, hardwareMaxCtx)`

#### Scenario: Context selector shows safe range indicator

- GIVEN a model where `hardwareMaxCtx` is less than `ggufContextLength`
- WHEN the user opens the context selector
- THEN options exceeding `hardwareMaxCtx` are visually distinguished (e.g., dimmed or flagged) to indicate they may cause OOM

#### Scenario: Fallback when GGUF metadata is null

- GIVEN a model with `ggufContextLength: null`
- WHEN the user selects that model
- THEN the context selector uses `hardwareMaxCtx` only, or shows all standard options as a fallback

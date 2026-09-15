# Delta for Local Model Catalog

**Files:** `openspec/specs/local-model-catalog/spec.md`

### Changes

1. Add activation flow (user activates from UI → POST activate → spawned).
2. Add lazy spawn on first `/v1/*` request if model is active but process stopped (idle-stop recovery).
3. Add missing GGUF → error state, boot not blocked.
4. Add `active` column in SQLite `models` table (persisted state).

## ADDED Requirements

### Requirement: Model activation flow

The system SHALL support activating a model from the UI, which triggers `POST /api/models/:id/activate`. Activation SHALL persist `active=1` in SQLite so the model is restored on next boot. Deactivation SHALL persist `active=0`.

#### Scenario: Activate from UI persists state

- GIVEN a model in the catalog with `active=0`
- WHEN the user activates it from the UI
- THEN `active=1` is written to SQLite and the model appears in `/v1/models`

#### Scenario: Deactivate from UI persists state

- GIVEN an active model with `active=1`
- WHEN the user deactivates it
- THEN `active=0` is written to SQLite and the model no longer appears in `/v1/models`

#### Scenario: Active state survives restart

- GIVEN a model with `active=1` in SQLite
- WHEN the app restarts
- THEN `hub.restoreActive()` reads the `active` column and re-spawns the model

### Requirement: Lazy re-spawn after idle-stop

When a request arrives for a model that is `active` in SQLite but whose process has been stopped (idle-stop or VRAM eviction), the system SHALL re-spawn the process transparently before forwarding the request. The request SHALL block on readiness (up to 30s) as if it were the initial activation.

#### Scenario: Request after idle-stop re-spawns

- GIVEN an active model whose process was idle-stopped
- WHEN a `/v1/chat/completions` request arrives
- THEN the process is re-spawned, the request blocks until ready, and the response succeeds

#### Scenario: Re-spawn failure returns 503

- GIVEN an active model whose process was idle-stopped but re-spawn fails
- WHEN a `/v1/*` request arrives
- THEN the request returns 503 (Service Unavailable)

### Requirement: Missing GGUF enters error state

When a model references a GGUF file that does not exist on disk, the model SHALL enter an error state with a clear message. The error SHALL NOT block boot or other model activations. The model SHALL be omitted from `/v1/models`.

#### Scenario: Missing GGUF is non-blocking

- GIVEN a model with `active=1` but a missing GGUF file
- WHEN the app starts
- THEN the model enters error state, boot continues, and `/v1/models` omits it

#### Scenario: Missing GGUF on activation returns error

- GIVEN a model whose GGUF file does not exist
- WHEN `POST /api/models/:id/activate` is called
- THEN an error is returned naming the missing file and no process is spawned

### Requirement: Active column in SQLite models table

The `models` table SHALL include `active INTEGER NOT NULL DEFAULT 0`. Fresh databases SHALL have this column in the CREATE statement. Existing databases SHALL receive an idempotent `ALTER TABLE models ADD COLUMN active INTEGER NOT NULL DEFAULT 0` migration (checked via `PRAGMA table_info(models)`).

#### Scenario: Fresh DB has active column

- GIVEN a new installation with no existing database
- WHEN the schema is created
- THEN the `models` table includes `active INTEGER NOT NULL DEFAULT 0`

#### Scenario: Existing DB gets migration

- GIVEN an existing database without the `active` column
- WHEN the app starts and `applySchema` runs
- THEN the column is added idempotently and existing rows get `active=0`

---

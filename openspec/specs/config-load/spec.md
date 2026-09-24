# Runtime Configuration Specification

## Purpose

WeaveLLM is configured **exclusively through environment variables**. There is
no config file: the runtime does not read `CONFIG_FILE`, `llm-proxy.config.yaml`,
or any YAML/JSON config from disk (`resolveAppConfig` in `src/app/config.ts`
builds the `AppConfig` from `process.env`). All six `WEAVELLM_*` variables have
safe defaults so the app boots without any setup. Persistent state (provider
rows, workflows, model config, secrets) is database- and keychain-backed, not
config-file-backed.

Bun's native `.env` auto-loading applies to the process; `WEAVELLM_*` values
defined in `.env` feed the same resolution pipeline as exported shell variables.

## Requirements

### Requirement: Environment-driven configuration with no config file

The system SHALL load its runtime configuration from environment variables
only, via `resolveAppConfig(env)`. It SHALL NOT load or require any
configuration file — `CONFIG_FILE`, `llm-proxy.config.yaml`, and equivalent
paths are dead concepts and MUST NOT be honored.

#### Scenario: Boot with no configuration provided

- GIVEN no `WEAVELLM_*` variable is set
- WHEN `resolveAppConfig` runs at boot
- THEN the app binds `127.0.0.1:4317` with auth disabled, platform app-data, the
  probed UI directory, and the `llama` binary from PATH

#### Scenario: No config file is read

- GIVEN the repo root contains no config file
- WHEN the app boots
- THEN boot succeeds without any config-file lookup and with no warning about a
  missing file

### Requirement: WEAVELLM_HOST controls the bind address

The system SHALL bind the HTTP server to `WEAVELLM_HOST` when set, defaulting to
`127.0.0.1` (loopback) for a local-first secure default.

#### Scenario: Custom bind host

- GIVEN `WEAVELLM_HOST=0.0.0.0`
- WHEN the server starts
- THEN it listens on all interfaces

#### Scenario: Default loopback bind

- GIVEN no `WEAVELLM_HOST`
- WHEN the server starts
- THEN it binds `127.0.0.1`

### Requirement: WEAVELLM_PORT selects the listen port

The system SHALL parse `WEAVELLM_PORT` as an integer in `0..65535` and bind that
port. `0` selects an ephemeral port (the server reports the bound URL in logs).
An unset, empty, non-numeric, negative, or out-of-range value SHALL fall back to
the default `4317`.

#### Scenario: Explicit port

- GIVEN `WEAVELLM_PORT=8080`
- WHEN the server starts
- THEN it listens on port 8080

#### Scenario: Ephemeral port

- GIVEN `WEAVELLM_PORT=0`
- WHEN the server starts
- THEN the OS assigns a free port and the bound URL is logged

#### Scenario: Invalid value falls back

- GIVEN `WEAVELLM_PORT=abc` or `WEAVELLM_PORT=70000`
- WHEN `resolvePort` parses it
- THEN the default `4317` is used instead of failing boot

### Requirement: WEAVELLM_AUTH enables the Bearer gate

The system SHALL enable the HTTP Bearer auth gate only when `WEAVELLM_AUTH`
equals exactly `1` or `true` (case-sensitive). Any other value — including
unset — SHALL leave auth disabled.

#### Scenario: Auth enabled

- GIVEN `WEAVELLM_AUTH=1` (or `true`)
- WHEN the server starts
- THEN `/v1` and `/api` requests without a valid Bearer token are rejected

#### Scenario: Auth disabled by default

- GIVEN no `WEAVELLM_AUTH` (or a value other than `1`/`true`)
- WHEN the server starts
- THEN no auth gate is applied

### Requirement: WEAVELLM_APP_DATA overrides the data directory

The system SHALL use `WEAVELLM_APP_DATA` as the application data directory
(SQLite database, logs, models) when set. When unset or empty, it SHALL use the
platform app-data directory resolved at boot.

#### Scenario: Custom data directory

- GIVEN `WEAVELLM_APP_DATA=/srv/weavellm`
- WHEN the app boots
- THEN SQLite and logs live under `/srv/weavellm`

### Requirement: WEAVELLM_UI_DIR overrides the compiled UI directory

The system SHALL serve the compiled admin console from `WEAVELLM_UI_DIR` when
set and non-empty, unconditionally. Otherwise it SHALL probe candidates in
order — `<cwd>/frontend/dist`, then the bundled `ui/` directory — and use the
first that contains an `index.html`; when none exists it SHALL fall back to
`<cwd>/frontend/dist`.

#### Scenario: Explicit UI directory wins

- GIVEN `WEAVELLM_UI_DIR=/opt/ui`
- WHEN the server starts
- THEN `/` serves `index.html` from `/opt/ui` even when a dev build exists

#### Scenario: Probing falls back to a dev build

- GIVEN no `WEAVELLM_UI_DIR` and `frontend/dist/index.html` present
- WHEN `resolveUiDir` runs
- THEN the dev build directory is used

### Requirement: WEAVELLM_LLAMA_BIN selects the llama-server binary

The system SHALL use `WEAVELLM_LLAMA_BIN` as the `llama-server` binary path for
the managed local backend. When unset or empty, it SHALL default to `llama`
(resolved from PATH).

#### Scenario: Custom binary path

- GIVEN `WEAVELLM_LLAMA_BIN=/opt/llama/bin/llama-server`
- WHEN the local backend preflights
- THEN that binary is version-checked (**b9908+** floor) and spawned

#### Scenario: Default binary from PATH

- GIVEN no `WEAVELLM_LLAMA_BIN`
- WHEN the local backend preflights
- THEN `llama` is resolved from PATH

### Requirement: State is not stored in a config file

All mutable configuration — provider rows (kinds, base URLs, fallback links),
workflow graphs, model configuration, activation state (`models.active`), and
secrets — SHALL be persisted in the app SQLite database and the keychain-backed
`SecretStore`, not in a config file. The gateway auth key SHALL be the keychain
secret scoped `auth`; provider API keys SHALL be scoped `provider:<kind>`.

#### Scenario: Providers and workflows survive without a config file

- GIVEN providers and workflows were saved through the UI/API
- WHEN the app restarts with no config file
- THEN the saved providers and workflows are reloaded from SQLite and the
  keychain exactly as before
# Config Load Specification

## Purpose

Bun-native config loading with behavior parity to the dotenv/js-yaml loader: `CONFIG_FILE` honored, zod validation unchanged, `.env` precedence.

## Requirements

### Requirement: CONFIG_FILE env honored

The system MUST resolve the config path from the `CONFIG_FILE` env var, defaulting to `./llm-proxy.config.yaml`, resolved against the current working directory.

#### Scenario: Default config path

- GIVEN no `CONFIG_FILE` is set
- WHEN `loadGatewayConfig` runs
- THEN `./llm-proxy.config.yaml` is read from the working directory

#### Scenario: Custom path via CONFIG_FILE

- GIVEN `CONFIG_FILE` points to another config path
- WHEN the config loads
- THEN that file is read and drives the typed config

### Requirement: Native YAML and JSON parsing

The system MUST parse config files at runtime with Bun APIs — `Bun.YAML.parse(await Bun.file(path).text())` for `.yaml`/`.yml`, JSON parsing for `.json`. Static/bundled YAML import is forbidden because it cannot honor a runtime `CONFIG_FILE`.

#### Scenario: YAML or JSON config parses

- GIVEN a valid `.yaml`, `.yml`, or `.json` config file
- WHEN the loader reads it
- THEN the raw record is returned as an object

#### Scenario: Non-object YAML rejected

- GIVEN a YAML file whose top-level value is a scalar or null
- WHEN the loader parses it
- THEN loading fails with "Config file is not an object"

#### Scenario: Missing file fails clearly

- GIVEN `CONFIG_FILE` points to a path that does not exist
- WHEN the loader resolves it
- THEN loading fails with "Config file not found: <resolved path>"

### Requirement: Zod schema validation preserved

The system MUST validate the raw record with the existing zod schema, unchanged. Invalid config MUST fail with a zod error listing issue messages.

#### Scenario: Valid config yields typed result

- GIVEN a raw record satisfying the schema
- WHEN schema validation runs
- THEN a typed `GatewayConfig` is returned with default providers normalized

#### Scenario: Invalid config fails validation

- GIVEN a raw record missing required fields
- WHEN schema validation runs
- THEN validation fails with zod issue messages

### Requirement: .env precedence

The system MUST load environment variables with Bun's native precedence: `.env` < `.env.{NODE_ENV}` < `.env.local`, with values already exported in the process environment winning.

#### Scenario: Env file values are loaded

- GIVEN a `.env` file defining `BEARER_TOKEN`
- WHEN the gateway starts
- THEN `process.env.BEARER_TOKEN` is set from the file

#### Scenario: Process environment wins

- GIVEN `BEARER_TOKEN` already exported in the shell
- WHEN the gateway starts
- THEN the exported value wins over the `.env` file value
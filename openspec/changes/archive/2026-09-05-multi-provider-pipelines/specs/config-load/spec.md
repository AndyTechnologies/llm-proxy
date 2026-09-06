# Delta for Config Load

## ADDED Requirements

### Requirement: External providers config section

The system MUST accept an optional top-level `providers` section in the config. Each entry SHALL validate as `{ baseURL: string (required), apiKey?: string, headers?: Record<string, string>, models: string[] (required, model ids the provider exposes) }`. A config without `providers` MUST default to `{}` and behave identically to today's gateway. `${ENV}` references in `apiKey` and `headers` values SHALL be interpolated from the process environment at load; a reference to an unset variable MUST fail loading with a clear error naming the variable. Schema validation for this section SHALL run on zod `^3.25.76` (bumped from `^3.23.8`) to satisfy the `@ai-sdk/openai-compatible` peer range.

#### Scenario: Config without providers behaves unchanged

- GIVEN a config with no `providers` section
- WHEN the gateway loads it
- THEN loading succeeds, `providers` is `{}`, and all existing behavior is unchanged

#### Scenario: Valid providers section is typed

- GIVEN a config with `providers.external-a` containing baseURL, apiKey, headers, and models
- WHEN schema validation runs
- THEN a typed config exposes the provider with its resolved models

#### Scenario: Invalid provider entry fails validation

- GIVEN a provider entry missing `baseURL` or `models`
- WHEN schema validation runs
- THEN loading fails with a zod error listing the issue

#### Scenario: Env interpolation resolves at load

- GIVEN `apiKey: "${EXTERNAL_API_KEY}"` with the variable exported
- WHEN the config loads
- THEN the typed config carries the resolved secret

#### Scenario: Unset env reference fails load

- GIVEN an `apiKey` referencing an unexported variable
- WHEN the config loads
- THEN loading fails with a clear error naming the variable
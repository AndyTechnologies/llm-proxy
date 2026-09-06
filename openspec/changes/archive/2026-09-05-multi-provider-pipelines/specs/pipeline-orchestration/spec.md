# Delta for Pipeline Orchestration

## ADDED Requirements

### Requirement: Named-provider targeting on llm_call

The system SHALL resolve an `llm_call` node's execution provider from its `provider` field, falling back to the chain-level `defaultProvider` (or `provider`), and to the local llama-server when neither is set. When the resolved provider is an external provider from the `providers` config section, the node SHALL execute against that external API with the node's `model`. When the resolved provider is the local backend, execution SHALL remain on the managed llama-server fetch path.

#### Scenario: Node targets a configured external provider

- GIVEN a node with `provider: "external-a"` and `model: "m1"` and `providers.external-a` configured
- WHEN the graph engine executes the node
- THEN the call goes to external-a's baseURL with model `m1`

#### Scenario: Chain default resolves the external provider

- GIVEN a chain with `defaultProvider: "external-a"` and a node without `provider`
- WHEN the graph engine executes the node
- THEN the node executes against external-a

#### Scenario: No provider configured keeps the local path

- GIVEN a node without `provider` and a chain without provider defaults
- WHEN the graph engine executes the node
- THEN the call goes to the local llama-server exactly as today

#### Scenario: External final node streams over the same contract

- GIVEN a graph requested with `stream: true` whose last executed node targets an external provider
- WHEN the graph runs
- THEN only that final node streams, with exactly one terminal chunk followed by `data: [DONE]`
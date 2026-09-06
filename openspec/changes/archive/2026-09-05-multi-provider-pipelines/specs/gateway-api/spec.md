# Delta for Gateway API

## ADDED Requirements

### Requirement: External model listing and unknown-model 404

The system SHALL include models from configured external providers in `GET /v1/models`, alongside local llama.cpp models and `gateway/*` virtual chains. A `POST /v1/chat/completions` or `POST /v1/completions` request whose `model` matches no local llama.cpp model, no external provider model, and no `gateway/*` virtual chain MUST respond with HTTP 404 and an OpenAI-shaped error carrying `code: "model_not_found"`.

#### Scenario: Models list includes external models

- GIVEN external providers configured with models `["claude-sonnet"]`
- WHEN a client requests `GET /v1/models`
- THEN the list contains `claude-sonnet` plus the llama.cpp models and `gateway/*` chains

#### Scenario: Unknown model returns typed 404

- GIVEN a request with `model: "no-such-model"` matching no local, external, or virtual registry entry
- WHEN it reaches `/v1/chat/completions` or `/v1/completions`
- THEN the system responds 404 with an OpenAI-shaped error whose `code` is `model_not_found`

#### Scenario: External model request is served

- GIVEN a request whose `model` is listed by a configured external provider
- WHEN it reaches `/v1/chat/completions`
- THEN the request is routed to that external provider and does not 404
# Delta for Gateway Security

Delta over `openspec/specs/gateway-security/spec.md`: optional auth now defaults OFF and is keychain-backed; the proxy binds to localhost by default. Helmet, zod validation, and SSRF requirements are unchanged.

## MODIFIED Requirements

### Requirement: Optional Bearer token authentication

The system SHALL default to NO authentication. When enabled via settings, the system SHALL validate the `Authorization: Bearer <key>` header against the keychain-stored auth key (keychain-secrets). Requests with a missing or invalid key SHALL be rejected with HTTP 401 and the authentication_error envelope.
(Previously: gated by the `BEARER_TOKEN` environment variable; when set, missing/invalid token → 401.)

#### Scenario: Valid token accepted

- GIVEN auth enabled with keychain-stored key `secret123`
- WHEN a request includes `Authorization: Bearer secret123`
- THEN the request proceeds normally

#### Scenario: Missing token returns 401

- GIVEN auth enabled
- WHEN a request omits the Authorization header
- THEN the system responds with HTTP 401 and `{ error: { message: "Unauthorized", type: "authentication_error" } }`

#### Scenario: Default disables auth

- GIVEN auth never enabled (default)
- WHEN any request arrives
- THEN the request proceeds without authentication

## ADDED Requirements

### Requirement: Localhost-only binding by default

The proxy SHALL bind to 127.0.0.1 by default. Binding to other interfaces SHALL require explicit configuration.

#### Scenario: Default loopback bind

- GIVEN no network override
- WHEN the proxy starts
- THEN it listens on 127.0.0.1 only

#### Scenario: Explicit external bind

- GIVEN network configuration permitting a specific interface
- WHEN the proxy starts
- THEN it binds only to that configured interface
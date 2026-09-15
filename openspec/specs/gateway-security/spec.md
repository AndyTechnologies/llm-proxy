# Gateway Security Specification

## Purpose

Security layer providing HTTP hardening, optional authentication, request validation, and SSRF prevention.

## Requirements

### Requirement: HTTP security headers via helmet

The system SHALL apply helmet middleware to all responses, setting standard HTTP security headers (X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security, etc.).

#### Scenario: Security headers present on response

- GIVEN a client sends any request to the gateway
- WHEN the response is returned
- THEN the response includes helmet security headers

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

### Requirement: Request body validation via zod

The system SHALL validate all incoming request bodies against zod schemas. Invalid payloads SHALL be rejected before reaching the proxy layer.

#### Scenario: Invalid temperature rejected

- GIVEN a request with `temperature: "not-a-number"`
- WHEN zod validation runs
- THEN the system responds with HTTP 400 and a validation error message

#### Scenario: Missing required fields rejected

- GIVEN a chat completions request missing the `messages` array
- WHEN zod validation runs
- THEN the system responds with HTTP 400

### Requirement: SSRF prevention

The system SHALL NOT allow client-controlled input to determine the upstream URL. The upstream target SHALL be derived exclusively from server-side configuration.

#### Scenario: Config-driven upstream only

- GIVEN a request to any endpoint
- WHEN the system resolves the upstream target
- THEN the target URL comes from config/provider settings, never from request body fields
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

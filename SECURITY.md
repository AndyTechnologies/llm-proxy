# Security Policy

llm-proxy is an OpenAI-compatible LLM gateway for local llama.cpp backends. By
default it binds to `127.0.0.1` and, without a `BEARER_TOKEN`, is **unsecured**.
Treat it as a local-only service unless you explicitly harden it for a network.

## Supported versions

The project is pre-1.0 (`0.1.x`). Security fixes are applied to the current
release branch. We recommend always running the latest release or a build from
`main`.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | ✅ (current)       |
| < 0.1   | ❌                 |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.** Please
report them privately by emailing:

- **Email:** garciandy579@gmail.com

Please include:

- The affected version / commit you observed the issue on.
- A description of the vulnerability and its impact.
- A minimal reproduction, if possible (sanitized — no secrets or private paths).
- Suggested fix if you have one.

You will receive an acknowledgement within a few business days, and we will
coordinate a fix and disclosure timeline.

## Security model

The gateway applies several hardening layers described in the
`gateway-security` spec:

- **Optional Bearer authentication** via the `BEARER_TOKEN` environment
  variable. When set, every request must carry `Authorization: Bearer <token>`;
  mismatches return `401`. When unset, auth is disabled — be aware of this when
  exposing the service beyond loopback.
- **HTTP security headers** applied to all responses (`X-Content-Type-Options`,
  `X-Frame-Options`, `Strict-Transport-Security`, etc.).
- **Request body validation** via Zod; invalid payloads are rejected with `400`
  before reaching the proxy layer.
- **SSRF prevention:** the upstream URL is derived exclusively from server-side
  configuration — never from client-controlled input.
- **Error normalization:** errors are returned as OpenAI-shaped envelopes and
  do not leak internal details.

The gateway also manages and supervises the `llama-server` backend process,
including spawn, health-check, restart, and shutdown.

## Deployment hardening checklist

For any non-loopback deployment:

1. Set a strong `BEARER_TOKEN`.
2. Do **not** use `corsOrigins: "*"` unless you deliberately allow any origin.
3. Run behind HTTPS/TLS (a reverse proxy) so tokens and traffic are encrypted.
4. Keep `llama-server` and Bun updates current.
5. Restrict access with a firewall to trusted hosts or networks.

## Known limits

- The built-in auth is a single static Bearer token — sufficient for
  single-user and trusted-network use, but not a full identity/authorization
  layer. For multi-user or public deployment, put an authenticating reverse
  proxy (or an identity-aware gateway) in front.

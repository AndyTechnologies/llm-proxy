# Hard Verify — weavellm

- **Change**: `weavellm` (openspec/changes/weavellm)
- **Phase**: hard verify (adversarial break-testing, opt-in — maintainer confirmed YES)
- **Date**: 2026-09-15
- **Baseline**: HEAD `37eab810428956fc9abf458a524ac979c6bd0048`, tree clean, `bun test` 382 pass / 0 fail / 961 expect() (matches verify-report)
- **Mode**: RED-GREEN adversarial — one deliberate, isolated break per sensitive surface; focused suite after every injection; break reverted exactly before the next; tree byte-identical to HEAD at the end (`git diff` empty)

## Verdict

**SOUND** — round 1, no gaps found. Every injected break was caught by the existing suite (expected-fail present). Zero testing errors. No relay to Tasks.

## Per-break evidence

| # | Surface (spec) | Invariant | Injected break | Focused command | Expected-fail result | Revert proof |
|---|----------------|-----------|----------------|-----------------|----------------------|--------------|
| 1 | gateway-security (auth) | Enabled auth denies a wrong Bearer token (constant-time compare) | `src/routes/auth.ts`: `return safeEqual(parts[1], expected);` → `return true;` (accept any presented token) | `bun test src/routes/auth.test.ts src/routes/v1.test.ts` | **FAIL** 28 pass / 1 fail: `enabled + wrong token → denied` (expected false, received true). Malformed-header and missing-header denials still pass (header-shape checks intact) | Inverse edit; `git diff` empty |
| 2 | keychain-secrets (AES-256-GCM) | Tampered ciphertext/nonce or wrong key MUST fail GCM auth with `SecretTamperError` — never partial plaintext | `src/secrets/keychain.ts`: `throw new SecretTamperError();` → `return "";` (swallow auth failure) | `bun test src/secrets/keychain.test.ts` | **FAIL** 8 pass / 3 fail: `tampered ciphertext fails…`, `tampered nonce fails…`, `wrong key fails (GCM auth check)` — all three `.rejects.toThrow(SecretTamperError)` resolved instead of rejecting | Inverse edit; `git diff` empty |
| 3 | external-providers (429 fallback / routing) | 429 on the primary provider retries on the fallback (non-stream + stream + route) | `src/providers/fallback.ts`: `return status === 429 \|\| status >= 500;` → `return status >= 500;` (429 no longer retryable) | `bun test src/providers/fallback.test.ts src/routes/v1.test.ts` | **FAIL** 28 pass / 5 fail, exit 1: `429 on the primary provider retries on the fallback`, `a chain of two fallbacks is followed until one succeeds`, `all providers failing propagates the last error`, `non-stream calls apply provider fallback on 429` (v1), `HTTP failure before any content streams the fallback cleanly` | Inverse edit; `git diff` empty |
| 4 | workflow-sandbox (unshare -n isolation) | Linux sandbox MUST wrap the untrusted command in `unshare -n --` (no network namespace) | `src/sandbox/runner.ts`: `return ["unshare", "-n", "--", ...args];` → `return [...args];` (drop OS network isolation) | `bun test src/sandbox/runner.test.ts` | **FAIL** 20 pass / 1 fail, exit 1: `linux wraps the target command in 'unshare -n --' (no network namespace)`. Static-policy deny tests still pass (independent layer — correct) | Inverse edit; `git diff` empty |
| 5 | external-proxy (/v1 unknown-model 404) | Unmapped model MUST return the 404 `model_not_found` envelope | `src/routes/v1.ts`: `unknownModelError` `{ status: 404 }` → `{ status: 200 }` | `bun test src/routes/v1.test.ts` | **FAIL** 18 pass / 4 fail, exit 1: `unknown model returns 404 with the unknown-model envelope`, `no embedder configured → 404 model_not_found`, `an unknown gateway name is the unknown-model 404`, `gateway models without a runner configured are 404 too` | Inverse edit; `git diff` empty |

## Final-state proof

- After the last revert: `git diff` (tracked tree) **empty** → working tree byte-identical to HEAD `37eab81`. No commits, no new files in `src/`, no leftover breaks.
- Full suite re-run: **382 pass / 0 fail / 961 expect() across 39 files, exit 0** — identical to the verify-report baseline (`test_output_hash`-equivalent harness).

## Gaps findings

**None.** All five adversarial injections produced the expected suite failure on the first focused run. No suite-pass-on-break (testing-error) events; nothing to relay to Tasks. Round count therefore stays at 1 (relay counter untouched).

## Notes / scope

- The un-wired local-model path (arch-lint A1-1) was intentionally NOT break-tested per the phase rules — it is already recorded as `not-demonstrable`, and breaking it would prove nothing.
- Surfaces with dedicated passing tests that were NOT adversarially broken this round (chosen per the 3–5 high-value-break preference): /ws exactly-once terminal `[DONE]` + disconnect abort (`src/app/ws.test.ts`), SSE relay abort-on-disconnect (`src/routes/relay.test.ts`), sandbox timeout/output-cap/env-whitelist (`runner.test.ts` beyond the unshare test), loopback default bind (`server.test.ts`), config-store persistence (`model-config.test.ts`). Their soundness rests on verify-report COMPLIANT evidence, not on adversarial proof; a future hard-verify round may target them.
- No `AbortSignal` sandbox fix attempted (A1-3 is a design-seam finding, not a tested invariant this phase).
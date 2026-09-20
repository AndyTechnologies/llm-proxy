/**
 * llama-server spawn argument builder + port/version parsing (backend-management).
 *
 * Single-model spawn: all per-model flags come from the SQLite model config;
 * `--port 0` lets llama.cpp pick a free port, detected from stdout via
 * `listening on ...:(\d+)`. Args are a strictly typed `string[]` (Bun.spawn
 * array form — no shell), and every value is vetted for shell metacharacters
 * (threat matrix: process-args injection).
 */

/** q8_0 KV cache footprint — 1.0625 bytes per cache element (model-advanced-config). */
export const Q8_0_BYTES_PER_ELEMENT = 1.0625;

/** Rope-scaling block passed when YaRN is configured. */
export interface YaRNRope {
  scale: number;
  origCtx: number;
}

/** Everything the spawn builder needs, resolved from model_config + GGUF. */
export interface LlamaSpawnArgsInput {
  /** Absolute path to the GGUF file (`--model`). */
  modelPath: string;
  /** Target context in tokens (`--ctx-size`); already YaRN-scaled when rope is set. */
  ctxSize?: number;
  /** YaRN scaling: `--rope-scaling yarn --rope-scale <s> --yarn-orig-ctx <o>`. */
  rope?: YaRNRope;
  /** KV cache quantization (`--cache-type-k`). */
  cacheTypeK?: string;
  /** KV cache quantization (`--cache-type-v`). */
  cacheTypeV?: string;
  /** KV offload to GPU layers (`--n-cache-gpu`). */
  nCacheGpu?: number;
  /**
   * HOST prompt-cache cap in MiB (`--cache-ram`) — caps the host prompt cache
   * ONLY; it never touches the KV cache (`--cache-type-k/-v` stay as configured).
   */
  cacheRam?: number;
  /** GPU layers for compute offload (`--ngl`). */
  ngl?: number;
  /** Flash attention (`-fa on`). */
  flashAttn?: boolean;
  /**
   * Embeddings mode: pushes `--embeddings` (dedicated embedding model —
   * the hub spawns the settings.embedding_model-designated model with this).
   */
  embeddings?: boolean;
  /** Port (default 0 = ephemeral, detected from stdout). */
  port?: number;
  /** Bind host (default loopback). */
  host?: string;
}

/** Characters that must never appear in a spawn argument (shell metachars + controls). */
const SHELL_METACHARS = /[;&|<>$`"'\\\n\t\r]/;

/**
 * Reject a value containing shell metacharacters. Bun.spawn(array) never
 * invokes a shell, but defense-in-depth keeps args injection-proof and the
 * RED contract explicit (threat matrix: spawn-arg injection).
 */
export function assertSafeSpawnArg(value: string): void {
  if (SHELL_METACHARS.test(value)) {
    throw new Error(
      `rejected spawn argument: contains a shell metacharacter: ${JSON.stringify(value)}`,
    );
  }
}

function num(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(Math.trunc(value));
}

/**
 * Build the complete llama-server argv (strictly `string[]`). Flag order
 * follows the design spawn flow: model → ctx → YaRN → KV → cache-ram → ngl.
 */
export function buildLlamaSpawnArgs(input: LlamaSpawnArgsInput): string[] {
  const args: string[] = [];

  assertSafeSpawnArg(input.modelPath);
  args.push("--model", input.modelPath);

  if (input.embeddings === true) args.push("--embeddings");

  if (input.ctxSize !== undefined) {
    args.push("--ctx-size", num(input.ctxSize)!);
  }

  if (input.rope !== undefined) {
    const { scale, origCtx } = input.rope;
    args.push(
      "--rope-scaling",
      "yarn",
      "--rope-scale",
      num(scale)!,
      "--yarn-orig-ctx",
      num(origCtx)!,
    );
  }

  if (input.cacheTypeK !== undefined) {
    assertSafeSpawnArg(input.cacheTypeK);
    args.push("--cache-type-k", input.cacheTypeK);
  }
  if (input.cacheTypeV !== undefined) {
    assertSafeSpawnArg(input.cacheTypeV);
    args.push("--cache-type-v", input.cacheTypeV);
  }
  if (input.nCacheGpu !== undefined) args.push("--n-cache-gpu", num(input.nCacheGpu)!);
  if (input.cacheRam !== undefined) args.push("--cache-ram", num(input.cacheRam)!);
  if (input.ngl !== undefined) args.push("--ngl", num(input.ngl)!);
  if (input.flashAttn === true) args.push("-fa", "on");

  args.push("--port", String(input.port ?? 0), "--host", input.host ?? "127.0.0.1");
  return args;
}

/**
 * Detect the bound port from llama-server stdout (`--port 0` mode):
 * `listening on (http://)?<host>:<port>` (host may be IPv4 or bracketed IPv6).
 * Returns null on unrelated lines so the boot loop keeps scanning.
 */
export function parseListeningPort(line: string): number | null {
  const match = /listening on (?:https?:\/\/)?(?:\[[^\]]+\]|[^\s:]+):(\d+)/.exec(line);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * b9908+ version floor (llama.cpp 2026-07-08). Parses the build tag from
 * `--version` output in either real-world form — `(build 10679, ...)` — or
 * the condensed `b10679` tag; older or unparseable output fails the gate with
 * an actionable message (backend-management: fail fast at startup).
 */
export function checkLlamaVersionFloor(versionOutput: string): string {
  const match = /(?:\bbuild\s+|\bb)(\d{4,})\b/.exec(versionOutput);
  if (!match) {
    throw new Error(
      "unable to determine llama.cpp build from --version output; refusing to start. " +
        "Set the managed llama-server path to llama.cpp b9908+ (2026-07-08).",
    );
  }
  const build = Number(match[1]);
  if (build < 9908) {
    throw new Error(
      `llama.cpp build b${build} is older than the required floor b9908 (2026-07-08). ` +
        "Upgrade the managed llama-server binary to b9908 or newer.",
    );
  }
  return `b${match[1]}`;
}
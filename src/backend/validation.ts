/**
 * Fail-fast config validation for the managed llama-server backend.
 *
 * Runs at startup BEFORE spawning the process. Each check produces a clear,
 * actionable error message so the operator knows exactly what to fix:
 *  - Binary resolvable (PATH lookup or absolute path)
 *  - modelsDir exists and is a directory
 *  - Each GGUF file referenced in config.models exists on disk
 *
 * These are the spec's "Fail-fast config validation at startup" requirement.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { LlamaConfig } from "../config/schema.js";

/**
 * Resolve the llama binary. If the path is absolute and exists, return it.
 * Otherwise try PATH lookup via `which`.
 */
function resolveBinary(binary: string): string {
  if (path.isAbsolute(binary)) {
    if (!fs.existsSync(binary)) {
      throw new Error(
        `[backend] llama binary not found at path: ${binary}\n` +
          `  Fix: verify the path in config llama.binary or install llama.cpp`,
      );
    }
    return binary;
  }

  // PATH lookup via `which`
  try {
    const resolved = execFileSync("which", [binary], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (resolved) return resolved;
  } catch {
    // `which` failed — fall through to error
  }

  throw new Error(
    `[backend] llama binary "${binary}" not found on PATH\n` +
      `  Fix: install llama.cpp or set llama.binary to the absolute path`,
  );
}

/**
 * Resolve a model file path. Relative paths are resolved under modelsDir.
 * Absolute paths are used as-is.
 */
function resolveModelFile(
  modelsDir: string,
  file: string,
): string {
  if (path.isAbsolute(file)) return file;
  return path.resolve(modelsDir, file);
}

/**
 * Validate the entire backend config at startup. Throws on the first
 * actionable error found.
 */
export function validateBackendConfig(config: LlamaConfig): void {
  const binary = resolveBinary(config.binary);

  if (!config.autoStart) return;

  const modelsDir = path.resolve(config.modelsDir);
  if (!fs.existsSync(modelsDir) || !fs.statSync(modelsDir).isDirectory()) {
    throw new Error(
      `[backend] modelsDir does not exist or is not a directory: ${modelsDir}\n` +
        `  Fix: create the directory or update llama.modelsDir in config`,
    );
  }

  const modelEntries = Object.entries(config.models);
  if (modelEntries.length === 0) {
    throw new Error(
      `[backend] config llama.models is empty — at least one model is required for router mode\n` +
        `  Fix: add model entries to llama.models in config`,
    );
  }

  for (const [id, model] of modelEntries) {
    const resolved = resolveModelFile(modelsDir, model.file);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `[backend] GGUF file for model "${id}" not found: ${resolved}\n` +
          `  Fix: download the file or correct the "file" field in llama.models."${id}"`,
      );
    }
  }

  // Prevent log noise — only log if validation passes
  console.log(
    `[backend] validation passed: binary=${binary}, modelsDir=${modelsDir}, ${modelEntries.length} models verified`,
  );
}

/** Export for testing/mocking. */
export { resolveBinary, resolveModelFile };

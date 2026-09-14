/**
 * Pure, testable build-gate helpers shared by scripts/build-binaries.ts.
 * Kept separate from the executable script so `bun test` can exercise the
 * size gate and target matrix without shelling out.
 */

export const BUNDLE_SIZE_LIMIT = 100 * 1024 * 1024; // 100 MB, in bytes

export interface TargetTriple {
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
}

/** Release matrix — exactly the three supported targets (desktop-app-shell). */
export const SUPPORTED_TARGETS = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" },
] as const satisfies readonly TargetTriple[];

export function targetTriples(): TargetTriple[] {
  return [...SUPPORTED_TARGETS];
}

export interface SizeGateResult {
  ok: boolean;
  bytes: number;
  limit: number;
  mb: number;
}

/** Enforce the < 100 MB bundle gate; throws with a size report when exceeded. */
export function assertBundleSize(
  bytes: number,
  limit: number = BUNDLE_SIZE_LIMIT,
): SizeGateResult {
  const mb = bytes / (1024 * 1024);
  if (bytes > limit) {
    throw new Error(
      `bundle size gate failed: ${mb.toFixed(1)} MB exceeds the 100 MB limit`,
    );
  }
  return { ok: true, bytes, limit, mb };
}

/** Human label for a target triple (darwin-arm64). */
export function targetLabel(t: TargetTriple): string {
  return `${t.platform}-${t.arch}`;
}
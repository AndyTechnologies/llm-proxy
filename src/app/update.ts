export const UPDATE_REPO_OWNER = "AndyTechnologies";
export const UPDATE_REPO_NAME = "llm-proxy";

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
  offline: boolean;
}

export interface UpdateInfo {
  available: boolean;
  version?: string;
}

export interface ApplyUpdateResult {
  installed: boolean;
  reason?: "consent-required" | "nothing-to-install" | "error";
}

export type UpdateFetcher = (url: string) => Promise<Response>;
export type UpdaterInstaller = (version: string) => Promise<void>;

/** Release URL for a channel (stable → latest release). */
export function releaseUrl(channel: string): string {
  const base = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}`;
  return channel === "stable"
    ? `${base}/releases/latest`
    : `${base}/releases/tags/${channel}`;
}

/** Basic numeric semver comparison: "v0.2.0" vs "0.1.0" → -1/0/1. */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) =>
    v.replace(/^v/, "").split(".").map((p) => Number.parseInt(p, 10) || 0);
  const aa = nums(a);
  const bb = nums(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/**
 * Check for a newer release at boot. Network failures degrade to a silent
 * offline skip — startup never blocks on the update check.
 */
export async function checkForUpdate(opts: {
  fetcher: UpdateFetcher;
  currentVersion: string;
  channel: string;
}): Promise<UpdateCheckResult> {
  try {
    const res = await opts.fetcher(releaseUrl(opts.channel));
    if (!res.ok) return { available: false, offline: false };
    const body = (await res.json()) as { tag_name?: string };
    const tag = body.tag_name ?? "";
    if (tag === "") return { available: false, offline: false };
    const version = tag.replace(/^v/, "");
    return {
      available: compareVersions(version, opts.currentVersion) > 0,
      version,
      offline: false,
    };
  } catch {
    return { available: false, offline: true };
  }
}

/**
 * Install an available update — always gated on explicit user consent.
 * The UI surfaces availability; installation only happens after the user
 * accepts (desktop-app-shell: "install SHALL require explicit user consent").
 */
export async function applyUpdate(
  update: UpdateInfo,
  opts: { consent: boolean; installer: UpdaterInstaller },
): Promise<ApplyUpdateResult> {
  if (!update.available || update.version === undefined) {
    return { installed: false, reason: "nothing-to-install" };
  }
  if (!opts.consent) return { installed: false, reason: "consent-required" };
  await opts.installer(update.version);
  return { installed: true };
}
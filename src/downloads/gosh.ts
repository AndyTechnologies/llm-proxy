/**
 * gosh CLI integration (model-downloads).
 *
 * Drives the gosh-dl-cli sidecar (goshitsarch-eng/gosh-dl-cli, MIT, v0.6.3+)
 * from the DownloadEngine. This module is the ONLY place that knows the CLI
 * surface — the engine behind it consumes builders and parsers, never raw
 * argv, so a gosh flag change touches exactly this file.
 *
 * Verified CLI surface (README v0.6.3+):
 *   - direct mode: `gosh <url> -d <dir> -o <name> -x <N> --checksum sha256:<hex> --output json`
 *   - `--checksum` REQUIRES the `sha256:<hex>` prefix — a bare hex is silently
 *     ignored upstream (binding decision), so we validate the prefix here.
 *   - exit 0 = completed; 130 = interrupted (transfer preserved for resume);
 *     non-zero otherwise = failed.
 */

export interface GoshTransferOptions {
  url: string;
  /** Output directory (`-d`). */
  dir: string;
  /** Output filename (`-o`). */
  out: string;
  /** Expected SHA256 as bare lowercase hex — the `sha256:` prefix is applied. */
  checksumHex: string;
  /** Connections per download (`-x`); gosh default is 8. */
  maxConnections?: number;
}

const HEX_RE = /^[0-9a-f]+$/i;

/**
 * Validate and normalize a checksum to the `sha256:<hex>` form gosh requires.
 *
 * Accepts an already-prefixed `sha256:<hex>` (case-insensitive prefix) and
 * normalizes it. Throws on a bare hex — the form gosh silently ignores — on a
 * non-sha256 prefix, and on any length other than 64 hex chars.
 */
export function assertChecksumPrefix(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("checksum must be a string");
  }
  let hex = value;
  if (value.toLowerCase().startsWith("sha256:")) {
    hex = value.slice("sha256:".length);
  } else if (/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(
      `gosh checksum must use the sha256:<hex> prefix; bare hex "${truncate(value)}" is silently ignored upstream`,
    );
  }
  if (!HEX_RE.test(hex) || hex.length !== 64) {
    throw new Error(`gosh checksum must be sha256:<64-hex>, got: ${truncate(value)}`);
  }
  return `sha256:${hex.toLowerCase()}`;
}

/** Build the direct-mode transfer argv (argv[0] = the gosh binary). */
export function buildGoshTransferArgs(opts: GoshTransferOptions): string[] {
  const checksum = assertChecksumPrefix(opts.checksumHex);
  return [
    "gosh",
    opts.url,
    "-d",
    opts.dir,
    "-o",
    opts.out,
    "-x",
    String(opts.maxConnections ?? 8),
    "--checksum",
    checksum,
    "--output",
    "json",
  ];
}

/** Normalized view of one gosh `--output json` event line. */
export interface GoshEvent {
  status: "downloading" | "completed" | "error";
  /** Percent done (downloading only). */
  percent?: number;
  /** Bytes transferred (downloading/completed when reported). */
  bytes?: number;
  /** Error message (error only). */
  error?: string;
}

/**
 * Parse one gosh JSON output line, tolerating unknown/extra fields and the
 * non-JSON noise gosh can emit (keepalives, TUI artifacts). Returns null for
 * anything that is not a recognizable progress event.
 */
export function parseGoshEvent(line: string): GoshEvent | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const status = raw.status;
  if (status !== "downloading" && status !== "completed" && status !== "error") {
    return null;
  }
  const ev: GoshEvent = { status };
  if (status === "downloading" && raw.progress && typeof raw.progress === "object") {
    const progress = raw.progress as Record<string, unknown>;
    if (typeof progress.percent === "number") ev.percent = progress.percent;
    if (typeof progress.bytes === "number") ev.bytes = progress.bytes;
  }
  if (typeof raw.bytes === "number") ev.bytes = raw.bytes;
  if (status === "error" && typeof raw.error === "string") ev.error = raw.error;
  return ev;
}

/** Shorten a value for error messages (never expose full checksum material). */
function truncate(value: string): string {
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}
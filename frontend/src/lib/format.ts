/** Human-readable byte sizes using binary (KiB/MiB) units. */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = Math.floor(Math.log(bytes) / Math.log(1024));
  i = Math.min(i, units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : fractionDigits)} ${units[i]}`;
}

/** Shorten context windows that are whole kibibytes (32768 → "32k"). */
export function formatContext(ctx: number | null | undefined): string {
  if (ctx == null || !Number.isFinite(ctx) || ctx <= 0) return "unknown";
  if (ctx >= 1024 && ctx % 1024 === 0) return `${ctx / 1024}k`;
  return String(ctx);
}
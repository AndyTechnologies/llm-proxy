/**
 * Static header resolution for external providers (external-providers spec):
 * `${ENV}` placeholders are interpolated from the environment at registry
 * build time. Non-secret values only — credentials come from the keychain
 * store, never from headers.
 */

/** Replace every `${NAME}` occurrence with env[NAME] (missing → ""). */
export function interpolateHeaders(
  headers: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (headers === undefined) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, varName: string) => {
      return env[varName] ?? "";
    });
  }
  return out;
}
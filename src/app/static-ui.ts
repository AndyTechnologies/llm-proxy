import { existsSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const STATIC_METHODS = new Set(["GET", "HEAD"]);

/**
 * Decode and normalize a URL pathname into a safe relative path inside the
 * UI build dir. Returns null for any request that must not touch disk:
 * malformed encoding, null bytes, or a `..` traversal attempt.
 */
function toRelativePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return null;

  // /ui is an alias for the build-dir root; everything else maps 1:1.
  let rel: string;
  if (decoded === "/" || decoded === "/ui" || decoded === "/ui/") {
    rel = "index.html";
  } else if (decoded.startsWith("/ui/")) {
    rel = decoded.slice("/ui/".length);
  } else if (decoded.startsWith("/")) {
    rel = decoded.slice(1);
  } else {
    rel = decoded;
  }

  const clean: string[] = [];
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null; // traversal attempt
    clean.push(segment);
  }
  return clean.join("/");
}

/** True when the last path segment carries a file extension. */
function hasExtension(rel: string): boolean {
  return extname(rel) !== "";
}

/**
 * Serve a static file from the compiled UI build dir.
 *
 * Root paths (`/`, `/ui`, `/ui/`) and extensionless SPA routes resolve to
 * index.html; existing assets are served with Bun's inferred MIME type.
 * Returns null when the request must be declined (unsafe path, missing
 * asset, or a non-GET/HEAD method) so the caller answers 404.
 */
export function serveStaticUi(
  uiDir: string,
  pathname: string,
  method: string,
): Promise<Response | null> {
  if (!STATIC_METHODS.has(method)) return Promise.resolve(null);

  const rel = toRelativePath(pathname);
  if (rel === null) return Promise.resolve(null);

  const uiRoot = resolve(uiDir);
  const fullPath = resolve(uiRoot, rel);

  // resolve() collapses `.`/`..` segments, so re-check the result stays
  // inside the UI root even though toRelativePath already rejects `..`.
  if (fullPath !== uiRoot && !fullPath.startsWith(uiRoot + sep)) {
    return Promise.resolve(null);
  }

  if (existsSync(fullPath)) {
    if (rel === "index.html") {
      return Promise.resolve(
        new Response(Bun.file(fullPath), {
          headers: { "Content-Type": "text/html" },
        }),
      );
    }
    return Promise.resolve(new Response(Bun.file(fullPath)));
  }

  // Extensionless missing paths are SPA routes: serve the app shell.
  if (!hasExtension(rel)) {
    return Promise.resolve(
      new Response(Bun.file(join(uiRoot, "index.html")), {
        headers: { "Content-Type": "text/html" },
      }),
    );
  }
  return Promise.resolve(null);
}
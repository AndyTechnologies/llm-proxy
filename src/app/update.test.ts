import { describe, expect, test } from "bun:test";
import {
  checkForUpdate,
  applyUpdate,
  releaseUrl,
  type UpdateFetcher,
  type UpdaterInstaller,
} from "./update.js";

const jsonFetcher =
  (body: unknown, status = 200): UpdateFetcher =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe("checkForUpdate", () => {
  test("a newer release is reported available with its version", async () => {
    const result = await checkForUpdate({
      fetcher: jsonFetcher({ tag_name: "v0.2.0" }),
      currentVersion: "0.1.0",
      channel: "stable",
    });
    expect(result.available).toBe(true);
    expect(result.version).toBe("0.2.0");
    expect(result.offline).toBe(false);
  });

  test("same or older release means nothing to install", async () => {
    const result = await checkForUpdate({
      fetcher: jsonFetcher({ tag_name: "v0.1.0" }),
      currentVersion: "0.1.0",
      channel: "stable",
    });
    expect(result.available).toBe(false);
  });

  test("network failure degrades to a silent offline skip", async () => {
    const result = await checkForUpdate({
      fetcher: async () => {
        throw new TypeError("fetch failed");
      },
      currentVersion: "0.1.0",
      channel: "stable",
    });
    expect(result.available).toBe(false);
    expect(result.offline).toBe(true);
  });

  test("channel is reflected in the release URL", () => {
    expect(releaseUrl("stable")).toContain("releases/latest");
    expect(releaseUrl("canary")).toContain("canary");
  });
});

describe("applyUpdate", () => {
  test("without explicit consent nothing is installed", async () => {
    let installed = false;
    const installer: UpdaterInstaller = async () => {
      installed = true;
    };
    const result = await applyUpdate(
      { available: true, version: "0.2.0" },
      { consent: false, installer },
    );
    expect(result.installed).toBe(false);
    expect(result.reason).toBe("consent-required");
    expect(installed).toBe(false);
  });

  test("with consent the installer runs", async () => {
    let installed = false;
    const installer: UpdaterInstaller = async () => {
      installed = true;
    };
    const result = await applyUpdate(
      { available: true, version: "0.2.0" },
      { consent: true, installer },
    );
    expect(result.installed).toBe(true);
    expect(installed).toBe(true);
  });
});
/**
 * Electrobun v2 build configuration — WeaveLLM desktop shell.
 *
 * Research anchors (weavellm/research.md, S4/S5/S6):
 * - Bun main process: `build.mainProcess: "bun"` + `bun.entrypoint`.
 * - Cottontail JSC remains the default engine (no override here).
 * - Linux deps ship via Flatpak; native system webview keeps bundles < 100 MB.
 */

export interface ElectrobunMacConfig {
  codesign: boolean;
  notarize: boolean;
  createDmg: boolean;
}

export interface ElectrobunLinuxFlatpakConfig {
  /** Application ID used for the flatpak-builder manifest. */
  id: string;
  /** Runtime SDK the manifest targets (Ubuntu 24.04+ host). */
  runtime: string;
}

export interface ElectrobunLinuxConfig {
  flatpak: ElectrobunLinuxFlatpakConfig;
  /** Chromium bundling — off: keeps the bundle under the 100 MB gate. */
  bundleCEF: boolean;
  bundleWGPU: boolean;
  defaultRenderer: "native" | "cef";
}

export interface ElectrobunConfig {
  /** Product name used for artifacts and the app bundle. */
  name: string;
  /** App version mirrored from hutch.config's channel release. */
  version: string;
  build: {
    mainProcess: "bun";
    /** Entrypoint of the Bun main process (boot + proxy server). */
    entrypoint: string;
    /** Release matrix — exactly the three supported targets. */
    targets: string[];
    mac: ElectrobunMacConfig;
    linux: ElectrobunLinuxConfig;
  };
}

export const config: ElectrobunConfig = {
  name: "weavellm",
  version: "0.1.0",
  build: {
    mainProcess: "bun",
    entrypoint: "src/main.ts",
    targets: ["darwin-arm64", "darwin-x64", "linux-x64"],
    mac: {
      codesign: false,
      notarize: false,
      createDmg: true,
    },
    linux: {
      flatpak: {
        id: "dev.weavellm.app",
        runtime: "org.gnome.Platform//46",
      },
      bundleCEF: false,
      bundleWGPU: false,
      defaultRenderer: "native",
    },
  },
};

export default config;
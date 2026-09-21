/**
 * Ambient declarations for the Electrobun v2 desktop SDK.
 *
 * The `electrobun` npm package is intentionally a throw-on-import bootstrap
 * stub ("Electrobun 2.x APIs come from the Hutch devkit, not node_modules").
 * The real SDK — types AND the main-process runtime behind `electrobun/main`
 * — is projected into the project by the Hutch devkit (`hutch electrobun
 * prepare` / `hutch electrobun build --env=<dev|canary|stable>`), which is
 * gated on the Cottontail engine download.
 *
 * The devkit is now available locally (`.hutch/devkit`, 2.0.2-beta.27) and
 * the BUNDLE resolves `electrobun/main` against it at build time. This file
 * is kept as the TYPECHECK surface instead of the devkit's own .ts sources
 * because `.hutch/` is generated toolchain state, not git-tracked: a fresh
 * clone would fail `tsc` if tsconfig pointed at it. These declarations
 * mirror the verified v2 API shape (including `build.copy`) so the config
 * typechecks anywhere. tsconfig "paths" maps `electrobun` / `electrobun/main`
 * to this file; keep it in sync with the devkit's `api/config/ElectrobunConfig.ts`
 * and `api/sdks/main/index.ts` as the API evolves.
 */

declare module "electrobun" {
  export interface ElectrobunAppConfig {
    name: string;
    identifier: string;
    version: string;
  }

  export interface ElectrobunBunProcessConfig {
    entrypoint: string;
  }

  export interface ElectrobunBuildConfig {
    mainProcess: "bun";
    bun: ElectrobunBunProcessConfig;
    /**
     * Files to copy directly to the build output. Key is a project source
     * path; value is a safe relative path inside the packaged application
     * (e.g. `{ "frontend/dist": "ui" }` → `Resources/app/ui/`).
     */
    copy?: Record<string, string>;
  }

  export interface ElectrobunConfig {
    app: ElectrobunAppConfig;
    build: ElectrobunBuildConfig;
  }
}

declare module "electrobun/main" {
  export interface BrowserWindowOptions {
    title?: string;
    url: string;
    frame?: { width: number; height: number };
  }

  export class BrowserWindow {
    constructor(options: BrowserWindowOptions);
  }
}
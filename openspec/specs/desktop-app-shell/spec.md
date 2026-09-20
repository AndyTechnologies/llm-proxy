# Desktop App Shell Specification

## Purpose

Single-binary desktop distribution for macOS 14+ (arm64/x64) and Linux x64 (Ubuntu 24.04+). Built on Electrobun v2 with a Bun main process, renders the Astro/Svelte SPA in the webview, and ships as a portable self-contained single-file executable (no installer, no auto-updater).

## Requirements

### Requirement: Cross-platform single-binary packaging

The system MUST package as a single distributable binary for macOS 14+ (arm64 and x64) and Linux x64 (Ubuntu 24.04+). Release binaries SHALL be built from the Electrobun v2 dev bundle via Hutch and MUST stay under 100 MB. Electrobun v2 builds are host-only: each target MUST be built on its own platform.

#### Scenario: Host target builds

- GIVEN the release pipeline on a supported target platform
- WHEN a release is built
- THEN a single-file binary is produced for the host target (darwin-arm64, darwin-x64, or linux-x64)
- AND it is under 100 MB

#### Scenario: Size gate fails the build

- GIVEN a bundle exceeding 100 MB
- WHEN the release build runs
- THEN the build fails with a size report

### Requirement: Electrobun main process on Bun

The main process SHALL run on Bun (`build.mainProcess: "bun"`) with the app entrypoint declared via `bun.entrypoint`. The Cottontail JSC engine SHALL be the default.

#### Scenario: App boots via Bun main process

- GIVEN an installed binary
- WHEN the app launches
- THEN the Bun main process starts and opens the webview window

#### Scenario: Default engine used

- GIVEN no explicit engine override
- WHEN the app builds
- THEN Cottontail JSC is selected

### Requirement: Astro SPA in webview

The UI SHALL be an Astro 7.3.2 static-output SPA using Svelte 5.57.0 via @astrojs/svelte 9.0.1, rendered in the Electrobun webview. Astro 7 SHALL use native static output (adapter-static is removed in v7).

#### Scenario: Static build serves the SPA

- GIVEN the frontend sources
- WHEN the Astro build runs
- THEN native static output is produced and loads in the webview

#### Scenario: Svelte islands hydrate

- GIVEN the SPA loaded
- WHEN the workflow editor mounts
- THEN interactive Svelte islands hydrate and respond to input

### Requirement: Portable single-file distribution (no installer, no updater)

The system SHALL distribute as ONE self-contained executable that embeds the complete app (Electrobun shell, Bun main process, SPA UI). The binary MUST NOT install itself, integrate system-wide, or self-update: no installer, no update channel, no Cottontail setup artifacts.

#### Scenario: One file runs the whole app

- GIVEN a portable binary on a supported host
- WHEN the user executes it
- THEN the Electrobun window opens with the SPA, with no installation step

#### Scenario: Cached extraction is reused

- GIVEN the binary was executed once before
- WHEN the user executes it again with the same payload
- THEN the bundle is reused from the extraction cache instead of being extracted again

#### Scenario: Default webview render environment

- GIVEN the app starts on Linux (WebKitGTK)
- WHEN `WEBKIT_DISABLE_DMABUF_RENDERER` is not already set in the environment
- THEN the launcher sets it to `1` so the webview does not render black
- AND an explicit user value still wins

### Requirement: Cold start latency

The app SHALL reach an interactive UI within 2 seconds of launch on a reference machine.

#### Scenario: Cold start under budget

- GIVEN a clean launch on a reference machine
- WHEN the user launches the app
- THEN the UI is interactive within 2 seconds
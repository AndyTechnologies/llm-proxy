# Desktop App Shell Specification

## Purpose

Single-binary desktop distribution for macOS 14+ (arm64/x64) and Linux x64 (Ubuntu 24.04+). Built on Electrobun v2 with a Bun main process, renders the Astro/Svelte SPA in the webview, and self-updates via Hutch.

## Requirements

### Requirement: Cross-platform single-binary packaging

The system MUST package as a single distributable binary for macOS 14+ (arm64 and x64) and Linux x64 (Ubuntu 24.04+). Release builds SHALL use Electrobun v2 with Hutch. Each bundle MUST stay under 100 MB.

#### Scenario: All three targets build

- GIVEN the release pipeline on a supported host
- WHEN a release is built
- THEN binaries are produced for darwin-arm64, darwin-x64, and linux-x64
- AND each bundle is under 100 MB

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

### Requirement: Auto-update check

The system SHALL check for updates at startup via Hutch. Availability SHALL be surfaced in the UI; installation SHALL require explicit user consent.

#### Scenario: Update available

- GIVEN a newer release on the update channel
- WHEN the app starts
- THEN the UI offers the update without auto-installing

#### Scenario: Offline startup

- GIVEN no network at startup
- WHEN the app starts
- THEN startup proceeds and the update check is skipped silently

### Requirement: Cold start latency

The app SHALL reach an interactive UI within 2 seconds of launch on a reference machine.

#### Scenario: Cold start under budget

- GIVEN a clean launch on a reference machine
- WHEN the user launches the app
- THEN the UI is interactive within 2 seconds
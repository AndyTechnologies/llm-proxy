/**
 * Models directory watcher (Slice A).
 *
 * Scans the models directory for candidate `*.gguf` models (case-insensitive)
 * and emits a `models:changed` hook whenever the detected candidate set
 * changes. Candidates are registration CANDIDATES ONLY — they are not
 * auto-registered; the dashboard-api model-list merge (Slice C) reads them.
 *
 * The scan can be injected for tests, but defaults to scanning the models dir
 * with the same gguf rule as `defaults.ts` (single source of truth for "what is
 * a model candidate").
 *
 * Pure/injectable: no global state, no auto-polling timer (callers drive
 * `refresh()` or start their own interval). `refresh()` is async and compares
 * the new candidate set to the last emitted set, emitting only on change.
 */
import { scanGgufFiles, bunDefaultsDeps, type DefaultsDeps } from "./defaults.js";

/** Event map for the models watcher. */
export interface ModelsWatcherEvents {
  models: "models:changed";
}

/** Listener signature for a models:changed event (fresh candidate set). */
type Listener<T extends keyof ModelsWatcherEvents> = (
  payload: string[],
) => void;

/** Injectable deps: override `scan` for tests (defaults to real gguf scan). */
export interface ModelsWatcherDeps {
  modelsDir: string;
  scan?: () => Promise<string[]>;
  defaultsDeps?: DefaultsDeps;
}

/** The models watcher surface. */
export interface ModelsWatcher {
  /** Run the scan now and return the current gguf candidates. */
  scan(): Promise<string[]>;
  /** Scan and, if the candidate set changed versus the last emitted set, emit. */
  refresh(): Promise<string[]>;
  on<K extends keyof ModelsWatcherEvents>(
    event: K,
    cb: Listener<K>,
  ): void;
  off<K extends keyof ModelsWatcherEvents>(event: K, cb: Listener<K>): void;
}

/** Compare two candidate sets ignoring order. */
function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

/** Create a models watcher for `modelsDir` with an injectable scan. */
export function createModelsWatcher(deps: ModelsWatcherDeps): ModelsWatcher {
  const scanFn =
    deps.scan ??
    (() => scanGgufFiles(deps.modelsDir, deps.defaultsDeps ?? bunDefaultsDeps));

  const listeners = new Set<Listener<"models:changed">>();
  // Candidate-only invariant: keep only local .gguf files regardless of what
  // the underlying scan returns. Initial baseline is empty so the first scan
  // only emits when it actually finds candidates.
  const toCandidates = (names: string[]): string[] =>
    names.filter((n) => /\.gguf$/i.test(n));

  let lastEmitted: string[] = [];

  function emit(files: string[]) {
    for (const cb of listeners) cb(files);
  }

  return {
    async scan() {
      return toCandidates(await scanFn());
    },
    async refresh() {
      const files = toCandidates(await scanFn());
      if (!setsEqual(files, lastEmitted)) {
        lastEmitted = files;
        emit(files);
      }
      return files;
    },
    on(_event, cb) {
      listeners.add(cb as Listener<"models:changed">);
    },
    off(_event, cb) {
      listeners.delete(cb as Listener<"models:changed">);
    },
  };
}

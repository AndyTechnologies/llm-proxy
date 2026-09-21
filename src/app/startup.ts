/** Cold-start measurement for the interactive UI budget (desktop-app-shell). */

export const COLD_START_BUDGET_MS = 2000;

/** Milliseconds since a performance.now() start mark. */
export function measureColdStart(startMark: number): number {
  return performance.now() - startMark;
}

/** True when the measured boot fits the interactive budget. */
export function coldStartOk(ms: number, budget = COLD_START_BUDGET_MS): boolean {
  return ms <= budget;
}
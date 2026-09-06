/**
 * bun:test matcher typings for @testing-library/jest-dom (svelte-ui, task 3.7).
 *
 * dom.ts extends bun:test's `expect` with jest-dom's matchers at runtime;
 * this declaration teaches tsc about the subset used across the component
 * suites so `bun run typecheck` stays green without dragging in jest's
 * global `expect` types.
 */
declare module "bun:test" {
  interface Matchers<T> {
    toBeDisabled(): T;
    toBeEnabled(): T;
    toBeVisible(): T;
    toHaveAttribute(attr: string, value?: string): T;
    toHaveTextContent(text: string | RegExp): T;
    toBeInTheDocument(): T;
    toBeEmptyDOMElement(): T;
  }
}

export {};
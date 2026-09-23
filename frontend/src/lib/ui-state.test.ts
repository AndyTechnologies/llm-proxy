import { describe, expect, test } from "bun:test";
import { get } from "svelte/store";
import { commandPaletteOpen, sidebarDrawerOpen } from "./ui-state.js";

describe("ui-state stores", () => {
  test("sidebar drawer defaults to closed", () => {
    sidebarDrawerOpen.set(false);
    expect(get(sidebarDrawerOpen)).toBe(false);
  });

  test("sidebar drawer toggles open and closed", () => {
    sidebarDrawerOpen.set(true);
    expect(get(sidebarDrawerOpen)).toBe(true);
    sidebarDrawerOpen.set(false);
    expect(get(sidebarDrawerOpen)).toBe(false);
  });

  test("command palette defaults to closed and opens", () => {
    commandPaletteOpen.set(false);
    expect(get(commandPaletteOpen)).toBe(false);
    commandPaletteOpen.set(true);
    expect(get(commandPaletteOpen)).toBe(true);
  });
});
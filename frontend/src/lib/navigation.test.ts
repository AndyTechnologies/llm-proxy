import { describe, expect, test } from "bun:test";
import { NAV_GROUPS, NAV_ITEMS, isRouteActive } from "./navigation.js";

describe("navigation registry", () => {
  test("every href is unique", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test("every href is root-relative", () => {
    for (const item of NAV_ITEMS) {
      expect(item.href.startsWith("/")).toBe(true);
    }
  });

  test("every group has at least one item", () => {
    for (const group of NAV_GROUPS) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  test("exact path matches its item", () => {
    expect(isRouteActive("/workflows", "/workflows")).toBe(true);
  });

  test("nested path highlights its parent item", () => {
    expect(isRouteActive("/models", "/models/catalog")).toBe(true);
  });

  test("root never highlights nested paths", () => {
    expect(isRouteActive("/", "/workflows")).toBe(false);
  });

  test("sibling section does not highlight", () => {
    expect(isRouteActive("/workflows", "/models")).toBe(false);
  });
});
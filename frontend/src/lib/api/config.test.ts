import { describe, expect, test } from "bun:test";
import { getApiOrigin, getWsOrigin, wsOriginFrom } from "./config.js";

describe("api origin helpers", () => {
  test("ws origin derives from an http origin", () => {
    expect(wsOriginFrom("http://127.0.0.1:4317")).toBe("ws://127.0.0.1:4317");
  });

  test("https origins map to wss", () => {
    expect(wsOriginFrom("https://models.example.com")).toBe("wss://models.example.com");
  });

  test("getApiOrigin returns an http url", () => {
    expect(getApiOrigin()).toMatch(/^https?:\/\//);
  });

  test("getWsOrigin returns a ws url", () => {
    expect(getWsOrigin()).toMatch(/^wss?:\/\//);
  });
});
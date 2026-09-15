/**
 * Boot wiring integration (Task 6.6, part 2).
 *
 * The real main-process boot with a fresh temp appData: workflow CRUD over
 * the persisted store, gateway/<name> models on /v1/models, and an actual
 * runner execution over a real socket — the chain v1 → api → store → runner.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "./main.js";

const DEMO_YAML =
  "name: Demo\n" +
  "nodes:\n" +
  "  - {id: start, type: start}\n" +
  "  - {id: end, type: end}\n" +
  "edges:\n" +
  "  - {from: start, to: end}\n";

describe("boot wiring (6.6)", () => {
  const appData = mkdtempSync(join(tmpdir(), "weavellm-boot-"));

  afterAll(() => {
    rmSync(appData, { recursive: true, force: true });
  });

  test("boot serves workflow CRUD, gateway models, and a real run", async () => {
    const { server } = await boot({
      ...process.env,
      WEAVELLM_PORT: "0",
      WEAVELLM_APP_DATA: appData,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      const put = await fetch(`${base}/api/workflows/demo`, {
        method: "PUT",
        headers: { "Content-Type": "text/yaml" },
        body: DEMO_YAML,
      });
      expect(put.status).toBe(200);

      const list = await fetch(`${base}/api/workflows`);
      expect(list.status).toBe(200);
      const records = (await list.json()) as Array<{ name: string }>;
      expect(records.some((w) => w.name === "demo")).toBe(true);

      const models = await fetch(`${base}/v1/models`);
      expect(models.status).toBe(200);
      expect(await models.text()).toContain("gateway/demo");

      const run = await fetch(`${base}/api/workflows/demo/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gateway/demo",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(run.status).toBe(200);
      const completion = (await run.json()) as {
        model: string;
        choices: Array<{ message: { content: string } }>;
      };
      expect(completion.model).toBe("gateway/demo");
      expect(completion.choices[0].message.content).toBe("");

      // The /ws surface is wired at boot too: bind the stored workflow and
      // stream one run to a terminal ok status.
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
        s.addEventListener("open", () => {
          clearTimeout(timer);
          resolve(s);
        });
      });
      const frames: Record<string, unknown>[] = [];
      const wsDone = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ws frames timeout")), 5000);
        ws.addEventListener("message", (ev) => {
          frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
          const msg = JSON.parse(String(ev.data)) as { type?: string; state?: string };
          if (msg.type === "status" && (msg.state === "ok" || msg.state === "error")) {
            clearTimeout(timer);
            ws.close();
            resolve();
          }
        });
      });
      ws.send(JSON.stringify({ type: "bind", workflow: "demo" }));
      ws.send(
        JSON.stringify({ type: "run", messages: [{ role: "user", content: "hi" }] }),
      );
      await wsDone;
      const terminal = frames[frames.length - 1];
      expect(terminal).toMatchObject({ type: "status", workflow: "demo", state: "ok" });
    } finally {
      server.stop();
    }
  });
});
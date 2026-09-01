import { spawn } from "node:child_process"; 
import { sleep } from "../utils/micro.js";

export class LlamaSwapManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.child = null;
    this.exited = true;
    this.shuttingDown = false;
  }

  get configuration() {
    return this.cfg;
  }
  
  get baseUrl() {
    return `http://${this.cfg.host}:${this.cfg.port}`;
  }

  buildArgs() {
    const template = this.cfg.args.map((arg) =>
      arg
        .replaceAll("{config}", this.cfg.config)
        .replaceAll("{host}", this.cfg.host)
        .replaceAll("{port}", String(this.cfg.port))
    );

    return [...template];
  }

  async start() {
    if (this.cfg.autoStart === false) {
      await this.waitReady();
      return;
    }

    const args = this.buildArgs();

    console.log(
      `[orchestrator] iniciando llama-swap: ${this.cfg.binary} ${args.join(" ")}`
    );

    this.exited = false;

    // detached: true crea un grupo de procesos.
    // Esto permite matar llama-swap y sus hijos llama serve con kill(-pid).
    this.child = spawn(this.cfg.binary, args, {
      stdio: "inherit",
      detached: true,
    });

    this.child.on("error", (err) => {
      console.error(`[orchestrator] error al lanzar llama-swap: ${err}`);
      process.exit(1);
    });

    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.child = null;

      if (!this.shuttingDown) {
        console.error(
          `[orchestrator] llama-swap terminó inesperadamente. code=${code} signal=${signal}`
        );
        process.exit(1);
      }
    });

    await this.waitReady();
  }

  async waitReady() {
    const startedAt = Date.now();
    const timeoutMs = this.cfg.startupTimeoutMs;

    const urls = [`${this.baseUrl}/health`, `${this.baseUrl}/v1/models`];

    while (Date.now() - startedAt < timeoutMs) {
      for (const url of urls) {
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(1000),
          });

          // Cualquier respuesta HTTP indica que el puerto está sirviendo.
          if (res.status > 0) {
            console.log(`[orchestrator] llama-swap listo en ${this.baseUrl}`);
            return;
          }
        } catch {
          // Todavía no está listo.
        }
      }

      await sleep(500);
    }

    throw new Error(
      `llama-swap no respondió en ${this.baseUrl} después de ${timeoutMs} ms`
    );
  }

  status() {
    return {
      baseUrl: this.baseUrl,
      pid: this.child?.pid ?? null,
      running: Boolean(this.child && !this.exited),
    };
  }

  waitExit(timeoutMs) {
    return new Promise((resolve) => {
      if (this.exited) {
        resolve();
        return;
      }

      const timer = setTimeout(resolve, timeoutMs);

      this.child?.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async stop() {
    if (!this.child || this.exited) {
      return;
    }

    this.shuttingDown = true;

    const pid = this.child.pid;

    if (!pid) {
      return;
    }

    console.log(`[orchestrator] deteniendo llama-swap pid=${pid}`);

    // SIGTERM al grupo de procesos.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // Proceso ya terminado.
      }
    }

    await this.waitExit(this.cfg.stopTimeoutMs);

    if (!this.exited) {
      console.error(
        `[orchestrator] llama-swap no salió con SIGTERM, enviando SIGKILL`
      );

      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Proceso ya terminado.
      }

      await this.waitExit(2000);
    }

    console.log("[orchestrator] llama-swap detenido");
  }
}

export const makeLlamaSwap = (cfg) => {
  return new LlamaSwapManager(cfg);
};
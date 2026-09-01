#!/usr/bin/env node
import { makeApp } from "./server.js";
import { loadLLMProxyConfig } from "./utils/config.js";
import { makeLlamaSwap } from "./llama-swap/ManLlamaSwap.js";

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const config = loadLLMProxyConfig();

if (!config.pipelines[config.defaultPipeline] || config.pipelines[config.defaultPipeline].length === 0) {
  throw new Error(
    `El pipeline por defecto "${config.defaultPipeline}" no existe o esta vacio en config.yaml`
  );
}

// ---------------------------------------------------------------------------
// Gestor de proceso llama-swap
// ---------------------------------------------------------------------------

const manager = makeLlamaSwap(config.llamaSwap);
if(!manager || manager === undefined){
  throw new Error(`Llama swap creation failed!`);
}
// ---------------------------------------------------------------------------
// Servidor Express
// ---------------------------------------------------------------------------

const app = makeApp(config, manager);


// ---------------------------------------------------------------------------
// Arranque y apagado
// ---------------------------------------------------------------------------

try {
  await manager.start();
} catch (err) {
  console.error(`[orchestrator] fallo al iniciar llama-swap: ${err}`);
  await manager.stop();
  process.exit(1);
}

const server = app.listen(config.server.port, config.server.host, () => {
  console.log(
    `[orchestrator] API OpenAI-compatible escuchando en http://${config.server.host}:${config.server.port}`
  );
  console.log(`[orchestrator] modelos virtuales: ${Object.keys(config.pipelines)}`);
});

let shuttingDown = false;

async function shutdown(reason) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`[orchestrator] apagando por ${reason}`);

  // Cierra conexiones HTTP pendientes.
  const forceConnections = setTimeout(() => {
    server.closeAllConnections?.();
  }, 3000);

  forceConnections.unref();

  await new Promise((resolve) => {
    server.close(() => resolve());
  });

  await manager.stop();

  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  console.error("[orchestrator] unhandledRejection:", reason);
  shutdown("unhandledRejection");
});

process.on("uncaughtException", (err) => {
  console.error("[orchestrator] uncaughtException:", err);
  shutdown("uncaughtException");
});


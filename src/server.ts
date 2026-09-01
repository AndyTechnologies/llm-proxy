/**
 * Express application factory.
 *
 * Creates and configures the Express 5 app with the full middleware stack:
 *  1. helmet() — HTTP security headers (gateway-security Req 1)
 *  2. JSON body parsing
 *  3. CORS (optional, from config)
 *  4. Auth middleware (optional Bearer)
 *  5. Route handlers (chat, completions, models, health)
 *  6. Error handler (last — catches everything above)
 *
 * The server.ts file is the ONLY place that knows about all middleware.
 * Routes and middleware are injected as dependencies, keeping them testable
 * and decoupled from the Express app lifecycle.
 */
import express from "express";
import helmet from "helmet";
import type { GatewayConfig } from "./config/schema.js";
import type { ParsedChain } from "./orchestrator/parser.js";
import type { Provider } from "./providers/types.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errors.js";
import { createChatHandler } from "./routes/chat.js";
import { createCompletionsHandler } from "./routes/completions.js";
import { createModelsHandler } from "./routes/models.js";
import { createHealthHandler } from "./routes/health.js";

export interface ServerDeps {
  config: GatewayConfig;
  chains: Map<string, ParsedChain>;
  providers: Map<string, Provider>;
}

export function createApp(deps: ServerDeps): express.Express {
  const app = express();

  // ── 1. Security headers (gateway-security Req 1) ──
  // helmet() MUST be explicit in src/index.ts/server per the refine gate.
  app.use(helmet());

  // ── 2. Body parsing ──
  app.use(express.json({ limit: deps.config.server.jsonLimit }));

  // ── 3. CORS (config-driven origins) ──
  const origins = deps.config.server.corsOrigins;
  if (origins && origins !== "*") {
    app.use((_req, res, next) => {
      const origin = Array.isArray(origins) ? origins[0] : origins;
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Chain-ID",
      );
      next();
    });
  }

  // ── 4. Auth (optional Bearer) ──
  app.use(authMiddleware);

  // ── 5. Routes ──
  const chatHandler = createChatHandler({
    chains: deps.chains,
    providers: deps.providers,
    llamaServer: deps.config.llamaServer,
  });
  const completionsHandler = createCompletionsHandler({
    chains: deps.chains,
    providers: deps.providers,
    llamaServer: deps.config.llamaServer,
  });
  const modelsHandler = createModelsHandler({
    chains: deps.chains,
    llamaServer: deps.config.llamaServer,
  });
  const healthHandler = createHealthHandler({
    config: deps.config,
    chains: deps.chains,
  });

  app.get("/health", healthHandler);
  app.get("/v1/models", modelsHandler);
  app.post("/v1/chat/completions", chatHandler);
  app.post("/v1/completions", completionsHandler);

  // ── 6. Global error handler (must be last) ──
  app.use(errorHandler);

  return app;
}

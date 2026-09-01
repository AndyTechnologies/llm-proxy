import express from "express";
import cors from "cors";
import { asyncHandler, extractPipelineName } from "./utils/micro.js";
import { runPipelineStream, runPipelineNonStream } from "./pipelines.js";

// ---------------------------------------------------------------------------
// EndPoints del proxy
// ---------------------------------------------------------------------------

// Handler para listar modelos. Soporta tanto /v1/models como /models.
const handleListModels = (self,req, res) => {
  const now = Math.floor(Date.now() / 1000);

  const data = Object.entries(self.config.pipelines).map(([name, pipeline]) => ({
    id: name,
    object: "model",
    created: now,
    owned_by: "orchestrator",
    permission: [],
    root: name,
    parent: null,
    description: pipeline.displayName ?? name,
  }));

  res.json({ object: "list", data });
};

const handleGetModel = (self, req, res) => {
  const name = req.params.modelId;
  const pipeline = self.config.pipelines[name];

  if (!pipeline) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      error: { message: `Modelo "${name}" no encontrado`, type: "invalid_request_error", code: "model_not_found" }
    }));
    return;
  }

  res.json({
    id: name,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "orchestrator",
    permission: [],
    root: name,
    parent: null,
    description: pipeline.displayName ?? name,
  });
};

const entries = {
  get:{
    health: (self) => {
      return (req,res) => {
        res.json({
          status: "ok",
          llamaSwap: self.manager.status(),
          pipelines: Object.keys(self.config.pipelines),
          defaultPipeline: self.config.defaultPipeline,
        });
      };
    },
  
    "v1/models": (self) => { return (req,res) => handleListModels(self,req,res); },
    "models": (self) => { return (req,res) => handleListModels(self,req,res); },

    
    
    "v1/models/:modelId": (self) => { return (req, res) => handleGetModel(self,req,res); },
    "models/:modelId": (self) => { return (req, res) => handleGetModel(self,req,res); },
  },

  post: {
    "v1/chat/completions": (self) => {
      const config = self.config;
      return asyncHandler( async (req, res) => {
        if (!Array.isArray(req.body?.messages)) {
          res.status(400).json({
            error: {
              message: "El cuerpo debe incluir messages como array",
              type: "invalid_request_error",
            },
          });
          return;
        }

        const requestedModel = req.body.model;
        const pipelineName = extractPipelineName(config, requestedModel);

        console.log(`[orchestrator] Petición completions para modelo: ${requestedModel} -> pipeline: ${pipelineName}`);
    
        try {
          const wantsStream = Boolean(req.body.stream);
      
          // AbortSignal ligado al cierre de la conexión del cliente.
          const reqAbortController = new AbortController();
      
          let closed = false;
          closed;
          
          req.on("close", () => {
            closed = true;
            reqAbortController.abort();
          });
      
          res.on("close", () => {
            closed = true;
            reqAbortController.abort();
          });
          
          if (wantsStream) {
            console.info(`[orchestrator] Iniciando pipeline con streaming: ${pipelineName}`);
            await runPipelineStream(
              config,
              pipelineName,
              req.body,
              res,
              reqAbortController.signal
            );
          } else {
            const result = await runPipelineNonStream(config, pipelineName, req.body);
            res.json(result);
          }
        } catch (err) {
          console.info(`[orchestrator] Error inesperado:\n${err}\n`);
          if (!res.headersSent && !res.writableEnded) {
            res.status(500).json({
              error: {
                message: String(err),
                type: "server_error",
              },
            }); // res.status(...).json(...)
          } // if
        } // catch
      }); // asyncHandler
    }, // v1/chat/completions

    "v1/completions": (self) => {
      const config = self.config;
      return asyncHandler(async (req,res)=>{
        const prompt = req.body.prompt ?? "";
    
        const chatInput = {
          ...req.body,
          messages: [{ role: "user", content: prompt }],
        };
        const requestedModel = req.body.model;
        const pipelineName = extractPipelineName(config, requestedModel);

        console.log(`[orchestrator] Petición completions para modelo: ${requestedModel} -> pipeline: ${pipelineName}`);
        
        try {
          const wantsStream = Boolean(req.body.stream);
      
          const reqAbortController = new AbortController();
      
          req.on("close", () => reqAbortController.abort());
          res.on("close", () => reqAbortController.abort());
      
          if (wantsStream) {
            if (!config?.pipelines) {
              throw new Error("config.pipelines es undefined");
            }
            // Reutilizamos runPipelineStream y convertimos chunks a formato legacy.
            const pipeline = config.pipelines[pipelineName];
            const stages = pipeline.stages;
            let previousContent = "";
    
            console.log(`[orchestrator] Corriendo para streaming pipeline: ${pipeline} `);
            for (let index = 0; index < stages.length - 1; index += 1) {
              const stage = stages[index];
              const messages = buildMessagesForStage(
                stage,
                index,
                stages,
                chatInput,
                previousContent
              );
    
              const response = await llamaChatNonStream({
                ...chatInput,
                model: stage.model,
                messages,
              });
    
              previousContent = extractContent(response);
              console.info(`[orchestrator] Llamada a IA no stream exitosa\n model: ${stage.model}\n response: ${previousContent}\n`);
            }
    
            const lastStage = stages[stages.length - 1];
            const lastMessages = buildMessagesForStage(
              lastStage,
              stages.length - 1,
              stages,
              chatInput,
              previousContent
            );
    
            const completionId = `cmpl-${crypto.randomBytes(12).toString("hex")}`;
            const created = Math.floor(Date.now() / 1000);
    
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.flushHeaders?.();

            reqAbortController.signal.addEventListener("abort", () => {
              if (!res.writableEnded) {
                res.end();
              }
            });

            try {

              const iterator = llamaChatStream(
                {
                  ...chatInput,
                  model: lastStage.model,
                  messages: lastMessages,
                },
                reqAbortController.signal
              );

              let receivedFinishReason = false;
              
              for await (const data of iterator) {
                let parsed;
                try {
                  parsed = JSON.parse(data);
                } catch {
                  continue;
                }
      
                const content = parsed.choices?.[0]?.delta?.content ?? "";

                if (parsed.choices?.[0]?.finish_reason) {
                  receivedFinishReason = true;
                }
                
                const legacyChunk = {
                  id: completionId,
                  object: "text_completion",
                  created,
                  model: pipelineName,
                  choices: [
                    {
                      text: content,
                      index: 0,
                      logprobs: null,
                      finish_reason: parsed.choices?.[0]?.finish_reason ?? null,
                    },
                  ],
                };
                
                res.write(`data: ${JSON.stringify(legacyChunk)}\n\n`);
              }

              // Si no recibimos finish_reason del upstream, enviar un chunk final sintético
              if (!receivedFinishReason) {
                const finalChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: pipelineName,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: "stop",
                    },
                  ],
                };
          
                res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
              }
              
              res.write(`data: [DONE]\n\n`);
              res.end();
            } catch (err) {
              if (!res.writableEnded) {
                const errorPayload = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: pipelineName,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: null,
                      error: {
                        message: String(err),
                      },
                    },
                  ],
                };
          
                res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
                res.write(`data: [DONE]\n\n`);
                res.end();
              }
            }
            
            
    
            
          } else {
            console.log(`[orchestrator] Corriendo para non-streaming pipeline: ${pipelineName} `);
            const result = await runPipelineNonStream(config, pipelineName, chatInput);
            const text = extractContent(result);
    
            res.json({
              id: `cmpl-${crypto.randomBytes(12).toString("hex")}`,
              object: "text_completion",
              created: Math.floor(Date.now() / 1000),
              model: pipelineName,
              choices: [
                {
                  text,
                  index: 0,
                  logprobs: null,
                  finish_reason: "stop",
                },
              ],
            });
          }
        } catch (err) {
          console.info(`[orchestrator] Error: ${err}\n`);
          if (!res.headersSent && !res.writableEnded) {
            res.status(500).json({
              error: {
                message: String(err),
                type: "server_error",
              },
            });
          }
        }
      }); // asyncHandler
    }, // v1/completions
  }, // post
};

// ---------------------------------------------------------------------------
// Funcion para crear el LLM Proxy
// ---------------------------------------------------------------------------

function makeProxy(app, manager, config){
  const llm_proxy = { manager, config, entries };

  if(!entries || !entries["get"] || !entries["post"]){
    throw new Error(`Error: entires is not correctly formed: ${JSON.stringify(entries)}`);
  }
  
  for(const entry in entries["get"]){
    console.log(`Entry: ${entry}`);
    const f = entries["get"][entry];
    app.get(`/${entry}`,f(llm_proxy));
  }

  for(const entry in entries["post"]){
    console.log(`Entry: ${entry}`);
    const f = entries["post"][entry];
    app.post(`/${entry}`,f(llm_proxy));
  }
  
  return llm_proxy;
}

// ---------------------------------------------------------------------------
// Funcion para crear la app de express y asignarle el llm_proxy
// ---------------------------------------------------------------------------

export const makeApp = (config, manager) => {
  const app = express();
  
  app.use(
    cors({
      origin:
        config.server.corsOrigins === "*" ? true : config.server.corsOrigins,
    })
  );

  app.use(express.json({ limit: config.server.jsonLimit }));

  const proxy = makeProxy(app, manager, config);

  app.llm_proxy = proxy;
  
  app.use((err, req, res) => {
    console.error("[orchestrator] error:", err);
  
    if (!res.headersSent && !res.writableEnded) {
      const payload = JSON.stringify({
        error: { message: err?.message ?? String(err), type: "server_error" }
      });
  
      // Fallback nativo si Express perdió el prototipo de res
      if (typeof res.status === "function") {
        res.status(500).json({ error: { message: err?.message ?? String(err), type: "server_error" } });
      } else {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(payload);
      }
    }
  });
  
  return app;
};


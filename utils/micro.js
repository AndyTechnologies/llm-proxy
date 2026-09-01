import crypto from "node:crypto";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function extractContent(response) {
  return (
    response?.choices?.[0]?.message?.content ??
    response?.choices?.[0]?.text ??
    ""
  );
}

export function makeCompletionId() {
  return `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Extrae el nombre del pipeline del modelo solicitado
// Soporta: "orchestrator" o "llm-proxy/orchestrator"
export function extractPipelineName(config, requestedModel) {
  if (!requestedModel) {
    return config.defaultPipeline;
  }

  const modelName = String(requestedModel);
  
  // Si contiene "/", tomar la parte después del último "/"
  if (modelName.includes("/")) {
    const parts = modelName.split("/");
    return parts[parts.length - 1];
  }
  
  return modelName;
}

// ---------------------------------------------------------------------------
// Sanitización de payload para compatibilidad con llama.cpp
// ---------------------------------------------------------------------------

export function sanitizePayloadForLlamaCpp(payload) {
  // Crear objeto nuevo sin los campos problemáticos
    const clean = {};
    
    // Copiar solo campos seguros
    if (payload.model) clean.model = payload.model;
    if (payload.messages) clean.messages = payload.messages;
    if (payload.stream !== undefined) clean.stream = payload.stream;
    if (payload.temperature !== undefined) clean.temperature = Math.max(0, Math.min(2, Number(payload.temperature)));
    if (payload.top_p !== undefined) clean.top_p = Math.max(0, Math.min(1, Number(payload.top_p)));
    if (payload.max_tokens !== undefined) clean.max_tokens = Math.max(1, Math.min(8192, Number(payload.max_tokens)));
    if (payload.max_completion_tokens !== undefined) {
      clean.max_tokens = Math.max(1, Math.min(8192, Number(payload.max_completion_tokens)));
    }
    if (payload.stop) clean.stop = payload.stop;
    
    // Normalizar roles developer -> system
    /*
    if (Array.isArray(clean.messages)) {
      clean.messages = clean.messages.map(msg => {
        if (msg.role === "developer") {
          return { ...msg, role: "system" };
        }
        if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter(p => p.type === "text").map(p => p.text).join("\n");
          return { ...msg, content: textParts };
        }
        return msg;
      });
    }
    */
    // NO copiar estos campos (causan error de gramática):
    // - tools (genera gramáticas GBNF complejas)
    // - tool_choice
    // - response_format
    // - grammar
    // - logprobs, top_logprobs, logit_bias
    // - stream_options
    // - store, reasoning_effort
    // - seed, n, user
    // - presence_penalty, frequency_penalty
    
    console.log(`[SANITIZE] Resultado final: model=${clean.model}, tiene_tools=${!!clean.tools}, tiene_grammar=${!!clean.grammar}`);
    
    return clean;
}
import { DEAFULT_GENERATE_PROMPT, DEFAULT_VERIFY_PROMPT } from "../prompts.js";
import { sanitizePayloadForLlamaCpp } from "../utils/micro.js"

export async function llamaChatNotStream(config,payload){
  const llamaSwapCfg = config.llamaSwap;
  const baseURL = `http://${llamaSwapCfg.host}:${llamaSwapCfg.port}`;
  const sanitized = sanitizePayloadForLlamaCpp(payload);
  console.log(`[SANITIZE] model=${sanitized.model}, tools=${!!sanitized.tools}, response_format=${!!sanitized.response_format}, grammar=${!!sanitized.grammar}`);
    
  
  const res = await fetch(`${baseURL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...sanitized, stream: false }),
    signal: AbortSignal.timeout(llamaSwapCfg.requestTimeoutMs),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`llama-swap error ${res.status}: ${text}`);
  }

  return JSON.parse(text);
}

// Devuelve un AsyncIterable<string> de los deltas de contenido SSE.
export function llamaChatStream(config, payload, abortSignal) {
  const llamaSwapCfg = config.llamaSwap;
  const baseURL = `http://${llamaSwapCfg.host}:${llamaSwapCfg.port}`;
  const sanitized = sanitizePayloadForLlamaCpp(payload);

  console.log(`[SANITIZE] model=${sanitized.model}, tools=${!!sanitized.tools}, response_format=${!!sanitized.response_format}, grammar=${!!sanitized.grammar}`);
  
  return (async function* () {
    const res = await fetch(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...sanitized, stream: true }),
      signal: abortSignal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`llama-swap error ${res.status}: ${text}`);
    }

    if (!res.body) {
      throw new Error("llama-swap no devolvió body en stream");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line || line === ":") {
          continue;
        }

        if (!line.startsWith("data:")) {
          continue;
        }

        const data = line.slice(5).trim();

        if (data === "[DONE]") {
          return;
        }

        yield data;
      }
    }
  })();
}

export function buildMessagesForStage(stage, stageIndex, stages, input, previousContent) {
  const mode = stage.mode ?? (stageIndex === 0 ? "generate" : "refine");

  if (mode === "passthrough") {
    return [...(input.messages ?? [])];
  }

  if (mode === "refine") {
    const previousModel = stages[stageIndex - 1]?.model ?? "anterior";

    return [
      {
        role: "system",
        content: stage.system ?? `${DEFAULT_VERIFY_PROMPT}`,
      },
      ...(input.messages ?? []),
      {
        role: "assistant",
        content: stage.assistant ?? `Previous response from model ${previousModel}:\n${previousContent}`,
      },
      {
        role: "user",
        content: stage.user ?? "Returns the final improved answer in the language in which the question was asked.",
      },
    ];
  }

  // generate
  return [
    ...(stage.system ? [{ role: "system", content: stage.system ?? `${DEAFULT_GENERATE_PROMPT}` }] : []),
    ...(input.messages ?? []),
  ];
}
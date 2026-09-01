import { llamaChatNotStream, llamaChatStream, buildMessagesForStage } from "./llama-swap/client.js";
import { extractContent, makeCompletionId } from "./utils/micro.js";

async function execPipe(config, index, stages, input, previousContent, finalResponse){
  const stage = stages[index];

  if (!stage?.model) {
    throw new Error(`Etapa ${index} del pipeline sin campo model`);
  }

  console.log(`[orchestrator] Etapa ${index + 1}/${stages.length} (non-stream): ${stage.model}`);
  
  const messages = buildMessagesForStage(
    stage,
    index,
    stages,
    input,
    previousContent
  );

  const payload = {
    ...input,
    model: stage.model,
    messages,
  };

  return [await llamaChatNotStream(config, payload), extractContent(finalResponse)];
}

export async function runPipelineNonStream(config, pipelineName, input) {
  const pipeline = config.pipelines[pipelineName];

  if (!pipeline?.stages || pipeline.stages.length === 0) {
    throw new Error(`Pipeline "${pipelineName}" vacío o inválido`);
  }

  const stages = pipeline.stages;
  const displayName = pipeline?.displayName ?? pipelineName;
  let previousContent = "";
  let finalResponse = null;

  console.info(`[STARTING PIPELINE] ${displayName}: ${stages.length} stages...`);
  
  for (let index = 0; index < stages.length; index += 1) {
    const [fres, content] = await execPipe(config, index, stages, input, previousContent, finalResponse);
    finalResponse = fres;
    previousContent = content;
  }

  // Sobrescribimos el model para que parezca el pipeline.
  if (finalResponse) {
    finalResponse.model = displayName;
  }
  
    return finalResponse;
}

export async function runPipelineStream(config, pipelineName, input, res, reqAbortSignal) {
  const pipeline = config.pipelines[pipelineName];

  if (!pipeline?.stages || pipeline.stages.length === 0) {
    throw new Error(`Pipeline "${pipelineName}" vacío o inválido`);
  }

  const stages = pipeline.stages;
  let previousContent = "";
  let finalResponse = null;

  // Todas las etapas menos la última se ejecutan sin streaming.
  for (let index = 0; index < stages.length - 1; index += 1) {
    const [fres, content] = await execPipe(config, index, stages, input, previousContent, finalResponse);
    finalResponse = fres;
    previousContent = content;
  }

  // Última etapa: streaming directo al cliente.
  const lastStage = stages[stages.length - 1];

  if (!lastStage?.model) {
    throw new Error(`Última etapa del pipeline sin campo model`);
  }

  const lastMessages = buildMessagesForStage(
    lastStage,
    stages.length - 1,
    stages,
    input,
    previousContent
  );

  const completionId = makeCompletionId();
  const created = Math.floor(Date.now() / 1000);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let finishReasonRecibido = false;

  reqAbortSignal.addEventListener("abort", () => {
    if (!res.writableEnded) {
      res.end();
    }
  });

  try {
    const iterator = llamaChatStream(
      {
        ...input,
        model: lastStage.model,
        messages: lastMessages,
      },
      reqAbortSignal
    );

    console.log(`[orchestrator] Etapa final ${stages.length}/${stages.length} (stream): ${lastStage.model}`);
    
    let chunksEnviados = 0;

    const enviarChunkFinal = () => {
      if (res.writableEnded) return;
  
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
            logprobs: null,
          },
        ],
      };
  
      console.log(`[orchestrator] >>> Enviando CHUNK FINAL con finish_reason=stop`);
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    };
    
    for await (const data of iterator) {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      parsed.id = completionId;
      parsed.model = pipelineName;
      parsed.created = created;

      if (parsed.object !== "chat.completion.chunk") {
        parsed.object = "chat.completion.chunk";
      }

      // Log detallado del chunk
      const delta = parsed.choices?.[0]?.delta ?? {};
      const finishReason = parsed.choices?.[0]?.finish_reason ?? null;
      const contentLen = (delta.content ?? "").length;

      console.log(`[STREAM] chunk #${chunksEnviados + 1}: content=${contentLen} chars, finish_reason=${finishReason}`);

      if (finishReason) {
        finishReasonRecibido = true;
      }

      chunksEnviados += 1;

      res.write(`data: ${JSON.stringify(parsed)}\n\n`);
    }

    console.log(`[orchestrator] Stream upstream completado. chunks=${chunksEnviados}, finish_reason_recibido=${finishReasonRecibido}`);
    
    // SIEMPRE enviar chunk final si no vino del upstream
    if (!finishReasonRecibido) {
      enviarChunkFinal();
    } else {
      // El upstream ya envió finish_reason, solo cerrar
      res.write(`data: [DONE]\n\n`);
      res.end();
    }
  } catch (err) {
    if (!res.writableEnded) {
      console.error(`[orchestrator] Error en streaming: ${err}`);

      // Un solo chunk terminal que lleva el error en banda (finish_reason: null,
      // NO finish_reason:"stop", NO fake). Seguido de [DONE] y res.end().
      const errorChunk = {
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

      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    }
  }
}

import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

export const loadConf = (configPath) => {
  const cfgPathResolved = path.resolve(
    process.cwd(),
    configPath
  );

  return load(fs.readFileSync(cfgPathResolved, "utf8")) ?? {};
};

export const loadLLMProxyConfig = () => {
  const rawConfig = loadConf( process.env.CONFIG_FILE ?? "./llm-proxy.config.yaml" );
  const config = {
    server: {
      host: rawConfig.server?.host ?? "127.0.0.1",
      port: Number(rawConfig.server?.port ?? 8090),
      corsOrigins: rawConfig.server?.corsOrigins ?? "*",
      jsonLimit: rawConfig.server?.jsonLimit ?? "10mb",
    },
  
    llamaSwap: {
      binary: rawConfig.llamaSwap?.binary ?? "llama-swap",
      config: rawConfig.llamaSwap?.config ?? "./llama-swap.config.yaml",
      host: rawConfig.llamaSwap?.host ?? "127.0.0.1",
      port: Number(rawConfig.llamaSwap?.port ?? 8080),
      autoStart: rawConfig.llamaSwap?.autoStart ?? true,
      startupTimeoutMs: Number(rawConfig.llamaSwap?.startupTimeoutMs ?? 60000),
      stopTimeoutMs: Number(rawConfig.llamaSwap?.stopTimeoutMs ?? 15000),
      requestTimeoutMs: Number(rawConfig.llamaSwap?.requestTimeoutMs ?? 300000),
      args: rawConfig.llamaSwap?.args ?? [
        "--config",
        "{config}",
        "--listen",
        "{host}:{port}",
      ]
    },
  
    defaultPipeline: rawConfig.defaultPipeline ?? "default",
    pipelines: rawConfig.pipelines ?? {
      default: [],
    },
  };

  return config;
 
};
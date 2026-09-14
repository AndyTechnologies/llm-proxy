# Quest: weavellm

## Approval: approved

## RFC

### Goals / Non-goals

**Goals:**
- Reconstruir el proyecto (mismo repo) como **WeaveLLM**: runtime de IA local autocontenido, app de escritorio con editor visual de workflows.
- Usuario descarga binario, lo ejecuta, funciona sin configuración externa (cero dependencias externas instaladas por el usuario).
- Proxy OpenAI-compatible activo (`/v1/*`) consumible por herramientas externas (Cursor, scripts).
- Orquestación visual de workflows (DAG) para mejorar respuestas de modelos pequeños con técnicas (MoA, debate, etc.).
- Gestión de modelos GGUF: catálogo curado + búsqueda HuggingFace + directorio local manual, descarga con reanudación y verificación SHA256.
- **Extensión controlada de contexto**: soporte YaRN con auto-cálculo de `rope-scale` y activación de KV cache quantizada para contextos largos.

**Non-goals (v1):**
- Windows (posterior).
- Mantener compatibilidad con los chains del proyecto actual (los workflows los reemplazan).
- Auto-update diferencial sí, pero sin UI compleja de suscripción/licencias.

### Domain Terminology & Business Rules

- **Workflow**: DAG de nodos que define un pipeline de procesamiento. Reemplaza el concepto legacy de "chain".
- **Nodo**: unidad atómica. Tipos: triggers, llm.call, prompt.template, logic.*, data.*, vector.*, memory.*, technique.*.
- **Sidecar**: proceso auxiliar — `llama-server` (persistente bajo demanda) y `gosh` (efímero, solo descargas).
- **Modelo virtual**: workflow expuesto como modelo `gateway/<workflow-name>` en `/v1/chat/completions`.
- **Técnica**: nodo compuesto que expande a subgrafo (self_consistency, moa, debate, chain_of_thought, reflexion, rag_local).
- Puerto fijo configurable (default 4317) con fallback si ocupado; auth externa opcional (default off).
- Catálogo = curado + búsqueda HF + directorio local manual.
- **Config avanzada por modelo** (persistida en SQLite): ctx-size, rope-scaling yarn, rope-scale (auto-calculado desde contexto original del GGUF), yarn-orig-ctx, KV cache quant (-ctk/-ctv), gpu layers (-ngl), flash-attention, cache-ram. **Samplers (temp, top-p, top-k, min-p, repeat-penalty, max_tokens) en el nodo llm.call** por llamada.

### Contracts (Inputs / Outputs / Events / External)

- `POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/embeddings`, `GET /v1/models` — proxy a 4 backends (local, openai, anthropic, openrouter) + modelos virtuales.
- `/api/*` CRUD workflows, modelos, proveedores, sistema; WebSocket `/ws` para streaming tokens (eventos `execution:*`, `download:progress`).
- Ingreso workflow YAML con schema `name/version/nodes/edges`; salida ejecución JSON normalizada.
- Persistencia: YAML (workflows) + SQLite (estado, cache modelos, keys cifradas, execution_log, kv_memory) via `bun:sqlite`.
- Sidecar `llama-server`: spawn con `--port 0`, puerto extraído de stdout, health-check 2s, idle timeout 5min.
- Descarga: `gosh` CLI (v0.2.9+, binario `gosh`) con `-x 16`, `--checksum sha256:`, `--output json`, reanudación nativa por ETag/Last-Modified. Abstracción interna para migrar a FFI después.
- **Arranque llama-server con flags avanzados** derivados de la config del modelo: `--rope-scaling yarn`, `--rope-scale`, `--yarn-orig-ctx`, `--ctx-size`, `-ctk/-ctv`, `-ngl`, `-fa`, `--cache-ram`.
- **Benchmark interno NIAH básico** accesible desde la UI del modelo para validar calidad tras extensión YaRN.

### Invariants & Validation

- Grafo workflow es DAG (ciclos rechazados), todos los node.id referenciados existen, tipos de datos de conexiones compatibles, config validada por schema por nodo.
- Un solo `llama-server` por modelo; nunca múltiples instancias para el mismo modelo.
- **`rope-scale` validado: debe ser ≥ 1 y coerente con `ctx_size / yarn_orig_ctx`; `yarn-orig-ctx` auto-detectado del metadata del GGUF siempre que sea posible; si no se puede detectar, config manual requerida antes de activar YaRN.**
- SHA256 verificado post-descarga antes de marcar modelo activo.
- API keys nunca en texto plano: AES-256-GCM con clave derivada de keychain del SO (macOS Keychain / Linux Secret Service).
- Nodo `data.code` ejecutado en sandbox (subproceso aislado, sin red, FS restringido a tmp, timeout).
- Tamaño bundle < 100 MB comprimido — verificable en build (falla si excede).

### Failure Cases & Edge Cases

- Fallback automático de proveedor en 5xx/timeout >30s (si configurado).
- TOCTOU en puerto dinámico de llama-server → leer puerto del stdout, no pre-asignar.
- Descarga interrumpida → reanudación nativa gosh; checksum fallido → descarga marcada corrupta, no activa.
- Kill switch por inactividad: timer 5min, SIGTERM → 5s → SIGKILL.
- Workflow con nodo fallido → estado `error`, nodos completados conservan salida, log en execution_log.
- Startup llama-server timeout 60s → kill + reporte.
- Cancelación de ejecución vía AbortSignal.
- **YaRN con ctx-size que excede memoria disponible → degradación de config (reducir ctx automáticamente o fallar con mensaje claro, nunca lanzar llama-server con OOM inminente).**
- **Modelo sin metadata de contexto original → no activar YaRN automático, pedir valor manual.**

### Security / Privacy / Performance / Operational

- Proxy externo: solo localhost por defecto; API key opcional (default off).
- data.code aislado (subproceso, sin net, tmp-only, timeout).
- Embeddings/RAG local: archivos indexados bajo appData, no fuera.
- Performance: cold start < 2s hasta ventana visible; batching continuo de llama-server para concurrencia MoA.
- **Contextos largos: KV cache quantizada (-ctk/-ctv) como opción por modelo para permitir 128K+ en VRAM/RAM limitada; activación de YaRN condicionada a la config del modelo, no global.**
- Logs JSON lines con rotación diaria en appData/logs.
- gosh-dl MIT elimina restricción GPL de aria2.

### Alternatives & Trade-offs

- CLI sidecar `gosh` ahora vs FFI nativo después → abstracción `DownloadEngine` para migrar sin tocar callers.
- Svelte Flow vs motor propio → Svelte Flow maduro y mantenible; nodos custom para técnicas.
- WebSocket principal vs SSE/polling → WS para todo el streaming (tokens, ejecución, descargas).
- Puerto fijo vs dinámico → fijo configurable para estabilidad de apps externas.
- **YaRN básico automático vs flags completos** → v1 expone ctx-size + rope-scaling yarn con auto-cálculo y KV cache quant; los samplers avanzados finos (min-p, DRY, presence-penalty) quedan para iteración posterior, no bloquean v1.
- **Config por modelo + override por nodo** → el spam es local y predecible; los nodos solo sobreescriben samplers.

### Acceptance Criteria (measurable)

1. `bun run build` produce bundle comprimido < 100 MB para darwin-arm64, darwin-x64, linux-x64.
2. Cold start < 2s hasta ventana visible (hardware típico SSD/8GB).
3. `/v1/chat/completions` funciona con modelo local GGUF descargado via gosh (reanudación + SHA256).
4. Editor visual permite crear workflow (trigger → llm.call → output), guardarlo YAML y ejecutarlo.
5. Técnica MoA con n=3 generadores + 1 agregador produce síntesis unificada (paralelismo verificado).
6. Embeddings + rag_local funcionan end-to-end.
7. Proveedores openai/anthropic/openrouter operativos con keys cifradas en keychain.
8. Fallback automático funciona en 5xx simulado.
9. Workflow expuesto como `gateway/<name>` consumible por cliente OpenAI externo.
10. Auto-update: verifica release GitHub al arranque y actualiza diferencialmente.
11. `bun test` suite completa verde (tests escritos desde cero).
12. data.code ejecuta en sandbox sin acceso red/FS fuera de tmp.
13. **Extensión YaRN: modelo GGUF con ctx original 32K → config de 128K en UI genera flags correctos (rope-scale 4, yarn-orig-ctx 32768, ctx-size 131072) y llama-server arranca con ellos; KV cache quant opcional aplicable.**
14. **Auto-detect: el contexto original del GGUF se lee del metadata o falla cerrado con mensaje claro pidiendo valor manual.**
15. **NIAH básico: accesible desde UI del modelo, ejecuta test de recuperación de aguja y reporta éxito/fallo.**

### Unresolved Questions (blocking)

- Ninguna.
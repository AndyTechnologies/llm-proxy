# ─────────────────────────────────────────────────────────────────────────────
# llm-proxy — multi-arch build (S3.3)
#
# Two stages:
#   build    : compile the gateway into a self-contained native binary
#              (bun build --compile) for the target architecture.
#   runtime  : minimal image that runs the binary.
#
# Multi-arch: build with buildx, e.g.
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     --build-arg TARGETARCH=amd64 -t llm-proxy:$(git rev-parse --short HEAD) .
#   (repeat per-arch with TARGETARCH=arm64, or script the loop)
#
# llama-server, GGUF models and the .llm-proxy preset dir are EXTERNAL — they
# are mounted as volumes, never baked in. The manager resolves the llama
# binary from PATH and reads models from the mounted models dir + config.
# ─────────────────────────────────────────────────────────────────────────────

# ── Build stage: compile to a native binary ──
FROM oven/bun:1.4 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the source (context excludes node_modules/dist/.llm-proxy via .dockerignore).
COPY tsconfig.json ./
COPY src ./src

# Map buildx TARGETARCH (amd64/arm64) → bun --target (x64/arm64). Default amd64.
ARG TARGETARCH=amd64
RUN if [ "$TARGETARCH" = "arm64" ]; then \
      TGT="bun-linux-arm64"; \
    else \
      TGT="bun-linux-x64"; \
    fi && \
    bun build src/index.ts --compile --target="$TGT" --outfile /app/llm-proxy

# ── Runtime stage: minimal image running the compiled binary ──
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/llm-proxy /app/llm-proxy

# llama-server must be on PATH in the runtime (mounted or via the base image).
ENV CONFIG_FILE=/config/llm-proxy.config.yaml
ENV PATH="/usr/local/llama/bin:${PATH}"

# Gateway port (config.server.port; the binary reads it from CONFIG_FILE).
EXPOSE 8090

# Health endpoints for orchestrators / k8s.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD test "$(wget -qO- http://127.0.0.1:8090/health/live)" = '{"status":"alive"}' || exit 1

ENTRYPOINT ["/app/llm-proxy"]

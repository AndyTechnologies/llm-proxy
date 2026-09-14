/**
 * Hutch toolchain configuration — WeaveLLM release pipeline.
 *
 * Research anchors (weavellm/research.md, S6): an exact `electrobun.version`
 * pin wins over bootstrap/channel; the `// @hutch` pragma comment pins the
 * toolchain (cli + cottontail) for reproducible builds.
 */

// @hutch cli=0.24.3 cottontail=0.5.0

export const TOOLCHAIN_PRAGMA = "// @hutch cli=0.24.3 cottontail=0.5.0";

export interface HutchConfig {
  electrobun: {
    /** Exact Electrobun version pin — wins over bootstrap/channel. */
    version: string;
  };
  /** Release channel: stable releases carry no channel suffix. */
  channel: "stable" | "canary" | "dev";
  release: {
    overrides: {
      stable: {
        /** Stable channel is enabled via env toggle by default. */
        env: boolean;
      };
    };
  };
}

export const config: HutchConfig = {
  electrobun: {
    version: "2.1.0",
  },
  channel: "stable",
  release: {
    overrides: {
      stable: {
        env: true,
      },
    },
  },
};

export default config;
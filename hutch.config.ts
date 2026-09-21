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
    // Latest published GitHub release with a signed electobun-artifacts.json.
    // 2.1.0 (the original research pin) was never published — hutch 404'd on
    // v2.1.0. Verified: v2.0.2-beta.27 serves the artifact (302).
    version: "2.0.2-beta.27",
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
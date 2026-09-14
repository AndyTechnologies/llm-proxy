/**
 * Curated model catalog (local-model-catalog: "curated list of well-known,
 * GGUF-format models"). Static, hand-maintained data — the entry source of
 * truth for one-click downloads.
 *
 * Integrity note: checksum values are intentionally NOT fabricated. A
 * trustworthy sha256 must come from the model card; entries carry `null`
 * until a user/automation supplies one. Download integrity therefore requires
 * a checksum at enqueue time (engine enforces it), and the registry only ever
 * stores digests that were actually verified.
 */

export interface CuratedModel {
  id: string;
  name: string;
  url: string;
  quant: string;
  /** Approximate download size in bytes (display metadata only). */
  sizeBytes: number;
  /** Native context window from the model card. */
  ggufCtx: number;
  description: string;
  /** Verified sha256 hex, or null when the model card does not publish one. */
  sha256: string | null;
}

export const CURATED_MODELS: CuratedModel[] = [
  {
    id: "llama-3.2-1b",
    name: "Llama 3.2 1B Instruct",
    url: "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q8_0.gguf",
    quant: "Q8_0",
    sizeBytes: 1_343_000_000,
    ggufCtx: 131072,
    description: "Compact instruction-tuned Llama 3.2 (1B), Q8_0.",
    sha256: null,
  },
  {
    id: "qwen2.5-0.5b",
    name: "Qwen 2.5 0.5B Instruct",
    url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q8_0.gguf",
    quant: "Q8_0",
    sizeBytes: 570_000_000,
    ggufCtx: 32768,
    description: "Tiny but capable instruct model from Qwen, official GGUF.",
    sha256: null,
  },
  {
    id: "smollm2-1.7b",
    name: "SmolLM2 1.7B Instruct",
    url: "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/resolve/main/smollm2-1.7b-instruct-q8_0.gguf",
    quant: "Q8_0",
    sizeBytes: 1_840_000_000,
    ggufCtx: 8192,
    description: "Small, efficient instruct model from Hugging Face (1.7B).",
    sha256: null,
  },
];

export function listCuratedModels(): CuratedModel[] {
  return CURATED_MODELS;
}
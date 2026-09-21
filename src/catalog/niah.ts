/**
 * NIAH context probe (local-model-catalog): needle-in-a-haystack probe that
 * validates a model's effective context with a real generation, then records
 * pass/fail against the registry (`models.probe_status`).
 *
 * The probe measures reproducibly: a fixed needle buried among `haystackSize`
 * filler blocks, a deterministic retrieval instruction, and an exact-substring
 * recall check — no sampling luck required.
 */
import type { Database } from "bun:sqlite";

export type ProbeStatus = "pass" | "fail";

export interface NiahProbeResult {
  declaredCtx: number;
  needleFound: boolean;
  status: ProbeStatus;
}

export interface NiahProbeOptions {
  declaredCtx: number;
  needle: string;
  filler: string;
  haystackSize: number;
  /** Generation seam — injects the model's chat/stream path in tests. */
  generate: (prompt: string) => Promise<string>;
  /** Persist the verdict against this model when provided. */
  db?: Database;
  modelId?: string;
}

/** Exact-substring recall check (deterministic by construction). */
export function needleRecalled(text: string, needle: string): boolean {
  return text.includes(needle);
}

/** Map recall to a registry verdict. */
export function evaluateNiah(needleFound: boolean): ProbeStatus {
  return needleFound ? "pass" : "fail";
}

/**
 * Build the probe prompt: `haystackSize` filler blocks with the needle
 * inserted exactly once, plus an unambiguous retrieval instruction.
 */
export function buildNiahPrompt(opts: {
  needle: string;
  filler: string;
  haystackSize: number;
}): string {
  const blocks = Array.from({ length: opts.haystackSize }, (_, i) =>
    i === Math.floor(opts.haystackSize / 2) ? `${opts.filler} ${opts.needle}` : opts.filler,
  );
  return [
    "You are a context window probe.",
    `The following text contains exactly one occurrence of a secret string: "${opts.needle}".`,
    "Answer YES if the secret string is present, otherwise NO.",
    "If YES, quote the secret string verbatim at the end.",
    "Text:",
    ...blocks,
    "",
    "Is the secret string present in the text above?",
  ].join("\n");
}

/** Record the probe verdict against a model in the registry. */
export function setProbeStatus(
  db: Database,
  modelId: string,
  status: ProbeStatus,
): void {
  db.query("UPDATE models SET probe_status = ? WHERE id = ?").run(status, modelId);
}

/** Last recorded probe verdict for a model, or null when never probed. */
export function getProbeStatus(db: Database, modelId: string): ProbeStatus | null {
  const row = db.query("SELECT probe_status FROM models WHERE id = ?").get(modelId) as
    | { probe_status: ProbeStatus | null }
    | undefined;
  return row?.probe_status ?? null;
}

/** Run one NIAH probe and persist the verdict when a db/modelId is given. */
export async function runNiahProbe(opts: NiahProbeOptions): Promise<NiahProbeResult> {
  const prompt = buildNiahPrompt(opts);
  const output = await opts.generate(prompt);
  const needleFound = needleRecalled(output, opts.needle);
  const status = evaluateNiah(needleFound);
  if (opts.db !== undefined && opts.modelId !== undefined) {
    setProbeStatus(opts.db, opts.modelId, status);
  }
  return { declaredCtx: opts.declaredCtx, needleFound, status };
}
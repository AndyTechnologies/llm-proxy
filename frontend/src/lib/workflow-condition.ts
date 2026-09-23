/**
 * Canonical condition source ⇄ SAFE AST converters (U06).
 *
 * `condition`/`router` nodes carry an AST (`AstExpr`) that the engine treats
 * as an opaque, non-editable blob. U06 makes the guarded expression editable
 * through a canonical SOURCE STRING whose grammar is a strict mirror of the
 * shapes `sanitizeAst` (src/orchestrator/graph.ts) admits — the backend SAFE
 * AST is the authoritative contract and the ONLY interpreter:
 *
 *   source  := expr
 *   expr    := "exists" "(" field ")"
 *            | "not" "(" expr ")"
 *            | ("all" | "any") "(" expr ("," expr)* ")"
 *            | field op2 literal
 *   field   := "lastResponse.status" | "lastResponse.content" | "error"
 *            | "variables" | "variables" "." ident ("." ident)*
 *   ident   := [A-Za-z_][A-Za-z0-9_]*
 *   op2     := "==" | "!=" | "<=" | ">=" | "<" | ">"
 *   literal := number | "string" | true | false | null | compact JSON value
 *
 * Values that are not primitives render as compact JSON and re-parse through
 * the JSON-literal fallback, so any AST the engine ever admitted round-trips.
 * Validation is two-gated: the grammar must parse AND the parsed AST must
 * survive the real `sanitizeAst` — the editor can never store an expression
 * the runtime would reject.
 *
 * Pure functions — no DOM, no Svelte, no stores — so this module runs under
 * `bun test` and in the Astro build.
 */
import { sanitizeAst, type AstExpr, type CompareOp2 } from "../../../src/orchestrator/graph.js";

// ── Rendering (AST → canonical source) ───────────────────────────────────────

/** Render a validated SAFE AST as its canonical source string (never throws). */
export function renderConditionSource(expr: AstExpr): string {
  switch (expr.op) {
    case "exists":
      return `exists(${expr.field})`;
    case "not":
      return `not(${renderConditionSource(expr.child)})`;
    case "logical":
      return `${expr.and ? "all" : "any"}(${expr.args.map(renderConditionSource).join(", ")})`;
    case "compare":
      return `${expr.field} ${expr.op2} ${renderValue(expr.value)}`;
  }
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return JSON.stringify(value);
}

// ── Parsing (source → AST) ────────────────────────────────────────────────────

export type ConditionParseResult =
  | { ok: true; expr: AstExpr }
  | { ok: false; error: string };

interface Cursor {
  src: string;
  pos: number;
}

function fail(cursor: Cursor, message: string): ConditionParseResult {
  return { ok: false, error: `Invalid condition at offset ${cursor.pos}: ${message}` };
}

function peek(cursor: Cursor): string {
  return cursor.src[cursor.pos] ?? "";
}

function skipWs(cursor: Cursor): void {
  while (cursor.pos < cursor.src.length && /\s/.test(cursor.src[cursor.pos]!)) cursor.pos += 1;
}

/** Match a literal keyword or operator, advancing on success. */
function eat(cursor: Cursor, token: string): boolean {
  if (cursor.src.startsWith(token, cursor.pos)) {
    cursor.pos += token.length;
    return true;
  }
  return false;
}

function eatIdent(cursor: Cursor): string | null {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(cursor.src.slice(cursor.pos));
  if (match === null) return null;
  cursor.pos += match[0].length;
  return match[0];
}

/**
 * Parse a dotted field reference into a SAFE context field. Strict mirror of
 * `isSafeField()`: only the three context fields or `variables`-prefixed
 * names are admitted.
 */
function parseField(cursor: Cursor): string | null {
  const first = eatIdent(cursor);
  if (first === null) return null;
  let field = first;
  while (eat(cursor, ".")) {
    const part = eatIdent(cursor);
    if (part === null) return null;
    field = `${field}.${part}`;
  }
  if (field === "lastResponse.status" || field === "lastResponse.content" || field === "error") {
    return field;
  }
  if (field === "variables" || field.startsWith("variables.")) return field;
  return null;
}

/** Comparison operators, longest match first (<= / >= before < / >). */
const OP2_TOKENS: readonly CompareOp2[] = ["==", "!=", "<=", ">=", "<", ">"];

function parseCompareOp2(cursor: Cursor): CompareOp2 | null {
  for (const op of OP2_TOKENS) {
    if (eat(cursor, op)) return op;
  }
  return null;
}

function parseString(cursor: Cursor): string | undefined {
  if (peek(cursor) !== '"') return undefined;
  let out = "";
  cursor.pos += 1;
  while (cursor.pos < cursor.src.length) {
    const ch = cursor.src[cursor.pos];
    cursor.pos += 1;
    if (ch === '"') return out;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const esc = cursor.src[cursor.pos];
    if (esc === undefined) return undefined;
    cursor.pos += 1;
    switch (esc) {
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      default:
        out += esc;
    }
  }
  return undefined;
}

/**
 * Attempt a compact JSON value occupying the ENTIRE remaining source. Only
 * canonical form qualifies (`JSON.stringify(parsed) === rest`), mirroring
 * `renderValue` — re-parsing rendered output always succeeds.
 */
function tryParseJsonLiteral(cursor: Cursor): { ok: true; value: unknown } | { ok: false } {
  const rest = cursor.src.slice(cursor.pos);
  try {
    const value: unknown = JSON.parse(rest);
    if (JSON.stringify(value) === rest) {
      cursor.pos = cursor.src.length;
      return { ok: true, value };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function parseLiteral(cursor: Cursor): { ok: true; value: unknown } | { ok: false } {
  skipWs(cursor);
  const ch = peek(cursor);
  if (ch === '"') {
    const value = parseString(cursor);
    return value === undefined ? { ok: false } : { ok: true, value };
  }
  if (ch === "t" && eat(cursor, "true")) return { ok: true, value: true };
  if (ch === "f" && eat(cursor, "false")) return { ok: true, value: false };
  if (ch === "n" && eat(cursor, "null")) return { ok: true, value: null };
  if (ch === "-" || (ch !== "" && /[0-9]/.test(ch))) {
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(cursor.src.slice(cursor.pos));
    if (match !== null) {
      cursor.pos += match[0].length;
      const value = Number(match[0]);
      if (Number.isFinite(value)) return { ok: true, value };
    }
    return { ok: false };
  }
  // Fallback: any other literal is a compact JSON value (arrays/objects a
  // saved workflow may carry — the engine admits them in `compare`).
  const json = tryParseJsonLiteral(cursor);
  if (json.ok) return json;
  return { ok: false };
}

function parseCompareExpr(cursor: Cursor): { ok: true; expr: AstExpr } | { ok: false; error: string } {
  const field = parseField(cursor);
  if (field === null) return fail(cursor, "comparison needs a supported field");
  skipWs(cursor);
  const op2 = parseCompareOp2(cursor);
  if (op2 === null) return fail(cursor, 'comparison needs an operator (==, !=, <, <=, >, >=)');
  const literal = parseLiteral(cursor);
  if (!literal.ok) return fail(cursor, "comparison needs a value (number, \"string\", true/false/null, or JSON)");
  return { ok: true, expr: { op: "compare", field, op2, value: literal.value } };
}

function parseExpr(cursor: Cursor): { ok: true; expr: AstExpr } | { ok: false; error: string } {
  skipWs(cursor);
  if (peek(cursor) === "") return fail(cursor, "expected an expression");
  if (eat(cursor, "exists")) {
    skipWs(cursor);
    if (!eat(cursor, "(")) return fail(cursor, 'expected "(" after exists');
    skipWs(cursor);
    const field = parseField(cursor);
    if (field === null) return fail(cursor, "unsupported field in exists(...)");
    skipWs(cursor);
    if (!eat(cursor, ")")) return fail(cursor, 'expected ")" to close exists(');
    return { ok: true, expr: { op: "exists", field } };
  }
  if (eat(cursor, "not")) {
    skipWs(cursor);
    if (!eat(cursor, "(")) return fail(cursor, 'expected "(" after not');
    const child = parseExpr(cursor);
    if (!child.ok) return child;
    skipWs(cursor);
    if (!eat(cursor, ")")) return fail(cursor, 'expected ")" to close not(');
    return { ok: true, expr: { op: "not", child: child.expr } };
  }
  let and: boolean;
  let logical = false;
  if (eat(cursor, "all")) {
    and = true;
    logical = true;
  } else if (eat(cursor, "any")) {
    and = false;
    logical = true;
  }
  if (logical) {
    skipWs(cursor);
    if (!eat(cursor, "(")) return fail(cursor, 'expected "(" after logical');
    const args: AstExpr[] = [];
    for (;;) {
      skipWs(cursor);
      const arg = parseExpr(cursor);
      if (!arg.ok) return arg;
      args.push(arg.expr);
      skipWs(cursor);
      if (eat(cursor, ")")) break;
      if (!eat(cursor, ",")) {
        return fail(cursor, 'expected "," or ")" inside logical');
      }
    }
    return { ok: true, expr: { op: "logical", and: and!, args } };
  }
  return parseCompareExpr(cursor);
}

/** Parse a canonical condition source string into a SAFE AST. */
export function parseConditionSource(source: string): ConditionParseResult {
  const cursor: Cursor = { src: source, pos: 0 };
  const expr = parseExpr(cursor);
  if (!expr.ok) return expr;
  skipWs(cursor);
  if (cursor.pos !== source.length) {
    return fail(cursor, `unexpected trailing input "${source.slice(cursor.pos)}"`);
  }
  return expr;
}

/** The backend authority: does this source express a runtime-admissible AST? */
export function isConditionSourceValid(source: string): boolean {
  const parsed = parseConditionSource(source);
  return parsed.ok && sanitizeAst(parsed.expr) !== null;
}
/**
 * U06 — condition source ⇄ SAFE AST converter tests.
 *
 * The grammar mirrors `sanitizeAst`'s admitted shapes; the last gate on top
 * is the REAL backend `sanitizeAst`, so these tests pin the round-trip and
 * the rejection surface (unsafe fields, missing values, trailing junk).
 */
import { describe, expect, test } from "bun:test";
import { sanitizeAst, type AstExpr } from "../../../src/orchestrator/graph.js";
import {
  isConditionSourceValid,
  parseConditionSource,
  renderConditionSource,
} from "./workflow-condition.js";

function render(source: string): string {
  const parsed = parseConditionSource(source);
  expect(parsed.ok).toBe(true);
  return renderConditionSource(parsed.expr);
}

describe("parseConditionSource", () => {
  test("parses exists on a context field", () => {
    const parsed = parseConditionSource("exists(lastResponse.content)");
    expect(parsed.ok).toBe(true);
    expect(parsed.expr).toEqual({ op: "exists", field: "lastResponse.content" });
  });

  test("parses not(...) with nested expressions", () => {
    const parsed = parseConditionSource("not(exists(error))");
    expect(parsed.ok).toBe(true);
    expect(parsed.expr).toEqual({ op: "not", child: { op: "exists", field: "error" } });
  });

  test("parses all(...) and any(...) with multiple args", () => {
    const all = parseConditionSource("all(lastResponse.status >= 200, exists(variables.step))");
    expect(all.ok).toBe(true);
    expect(all.expr).toEqual({
      op: "logical",
      and: true,
      args: [
        { op: "compare", field: "lastResponse.status", op2: ">=", value: 200 },
        { op: "exists", field: "variables.step" },
      ],
    });

    const any = parseConditionSource("any(lastResponse.status == 200, lastResponse.status == 429)");
    expect(any.ok).toBe(true);
    expect(any.expr).toEqual({
      op: "logical",
      and: false,
      args: [
        { op: "compare", field: "lastResponse.status", op2: "==", value: 200 },
        { op: "compare", field: "lastResponse.status", op2: "==", value: 429 },
      ],
    });
  });

  test("parses compare on every operator", () => {
    const ops = ["==", "!=", "<", "<=", ">", ">="] as const;
    for (const op of ops) {
      const parsed = parseConditionSource(`variables.count ${op} 3`);
      expect(parsed.ok).toBe(true);
      expect(parsed.expr).toEqual({
        op: "compare",
        field: "variables.count",
        op2: op,
        value: 3,
      });
    }
  });

  test("parses string, negative, decimal and boolean literals", () => {
    const strings = [
      ['lastResponse.content == "ok"', { op: "compare", field: "lastResponse.content", op2: "==", value: "ok" }],
      ['lastResponse.content == "a \\"quoted\\" pair"', { op: "compare", field: "lastResponse.content", op2: "==", value: 'a "quoted" pair' }],
      ["variables.score < -1.5", { op: "compare", field: "variables.score", op2: "<", value: -1.5 }],
      ["error != null", { op: "compare", field: "error", op2: "!=", value: null }],
      ["variables.flag == true", { op: "compare", field: "variables.flag", op2: "==", value: true }],
    ] as const;
    for (const [source, expected] of strings) {
      const parsed = parseConditionSource(source);
      expect(parsed.ok).toBe(true);
      expect(parsed.expr).toEqual(expected);
    }
  });

  test("tolerates whitespace and renders canonical form", () => {
    expect(render("  all ( lastResponse.status >= 200 , exists( lastResponse.content ) )  ")).toBe(
      "all(lastResponse.status >= 200, exists(lastResponse.content))",
    );
  });

  test("round-trips every AST shape through render → parse → sanitizeAst", () => {
    const corpus: AstExpr[] = [
      { op: "exists", field: "lastResponse.content" },
      { op: "not", child: { op: "exists", field: "error" } },
      {
        op: "logical",
        and: true,
        args: [
          { op: "compare", field: "lastResponse.status", op2: "==", value: 200 },
          { op: "not", child: { op: "exists", field: "lastResponse.content" } },
        ],
      },
      { op: "compare", field: "variables.step", op2: ">=", value: 2 },
      { op: "compare", field: "lastResponse.content", op2: "!=", value: "" },
      { op: "compare", field: "error", op2: "==", value: null },
      // Non-primitive compare value (engine admits anything in `value`).
      { op: "compare", field: "variables.tags", op2: "==", value: ["a", "b"] },
      { op: "compare", field: "variables.meta", op2: "==", value: { step: 1 } },
    ];
    for (const expr of corpus) {
      const source = renderConditionSource(expr);
      const parsed = parseConditionSource(source);
      expect(parsed.ok, `parse "${source}"`).toBe(true);
      expect(sanitizeAst(parsed.expr)).not.toBeNull();
      expect(renderConditionSource(parsed.expr)).toBe(source);
    }
  });

  test("rejects empty input", () => {
    const parsed = parseConditionSource("");
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("expected an expression");
  });

  test("rejects unsafe fields", () => {
    for (const source of [
      "exists(https://evil.example/x)",
      "exists(lastResponse)",
      "file.read == 1",
      "variables..x == 1",
    ]) {
      const parsed = parseConditionSource(source);
      expect(parsed.ok, source).toBe(false);
    }
  });

  test("rejects malformed expressions with position", () => {
    const trailing = parseConditionSource("exists(lastResponse.content) garbage");
    expect(trailing.ok).toBe(false);
    expect(trailing.error).toContain("trailing input");

    const unclosed = parseConditionSource("any( exists(lastResponse.content) ");
    expect(unclosed.ok).toBe(false);
    expect(unclosed.error).toContain("expected");

    const missingValue = parseConditionSource("lastResponse.status >=");
    expect(missingValue.ok).toBe(false);
    expect(missingValue.error).toContain("value");
  });
});

describe("isConditionSourceValid", () => {
  test("is true exactly when parse + sanitizeAst admit the source", () => {
    expect(isConditionSourceValid("lastResponse.status == 200")).toBe(true);
    expect(isConditionSourceValid("variables.attempt < 3")).toBe(true);
    // Parses but sanitizeAst rejects the op2? It cannot — the grammar admits
    // only allowed op2 — so the two gates agree on shape; unsafe values still
    // fail on the grammar side.
    expect(isConditionSourceValid("exists(lastResponse.status) && true")).toBe(false);
    expect(isConditionSourceValid("")).toBe(false);
  });
});
/**
 * Pure rendering helpers for the API playground (U11), kept UI-framework
 * free so they stay importable under bun:test.
 *
 * highlightJson is an honest JSON syntax highlighter: it splits an already
 * serialized JSON string into display tokens and NEVER alters or invents
 * content — joining the token values always reproduces the source exactly.
 * The playground renders the raw wire body through it; no derived metrics.
 */

export const JSON_TOKEN_KINDS = {
  key: "key",
  string: "string",
  number: "number",
  bool: "bool",
  null: "null",
  punct: "punct",
} as const;

export type JsonTokenKind = (typeof JSON_TOKEN_KINDS)[keyof typeof JSON_TOKEN_KINDS];

export interface JsonToken {
  kind: JsonTokenKind;
  value: string;
}

/** Single-character JSON punctuation (plus whitespace, preserved verbatim). */
const PUNCT_CHARS = new Set([" ", "\t", "\n", "\r", "{", "}", "[", "]", ":", ",", '"']);

/**
 * Tokenize a serialized JSON string for display. Keys are detected only in
 * the exact `"key":` position; every other double-quoted span is a string.
 * `true`/`false`/`null` become bool/null tokens; numbers are scanned as-is.
 * Whitespace is preserved inside `punct` tokens so the rendered text is
 * byte-identical to the input (join(tokens) === src).
 */
export function highlightJson(src: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const push = (kind: JsonTokenKind, value: string): void => {
    if (value.length === 0) return;
    tokens.push({ kind, value });
  };

  let i = 0;
  let prevNonSpace = "";
  while (i < src.length) {
    const ch = src[i];

    if (ch === '"') {
      // Scan the full string literal, honoring backslash escapes.
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') break;
        j += 1;
      }
      const literal = src.slice(i, Math.min(j + 1, src.length));
      // A key sits right before ':' after the string — detect via the next
      // non-space char (skip a possible second '"' for malformed input).
      let k = j + 1;
      while (k < src.length && /\s/.test(src[k])) k += 1;
      const isKey = src[k] === ":" && prevNonSpace !== '"';
      push(isKey ? "key" : "string", literal);
      prevNonSpace = '"';
      i = j + 1;
      continue;
    }

    if (/\d/.test(ch) || ch === "-") {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+\-]/.test(src[j])) j += 1;
      push("number", src.slice(i, j));
      prevNonSpace = "number";
      i = j;
      continue;
    }

    if (/[A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      if (word === "true" || word === "false") {
        push("bool", word);
      } else if (word === "null") {
        push("null", word);
      } else {
        push("punct", word); // unknown word — preserved verbatim
      }
      prevNonSpace = word;
      i = j;
      continue;
    }

    // Punctuation and whitespace: emit one token per char (byte-identical).
    if (PUNCT_CHARS.has(ch) || /\s/.test(ch)) {
      push("punct", ch);
      if (!/\s/.test(ch)) prevNonSpace = ch;
    } else {
      push("punct", ch); // unexpected byte (e.g. control char) — kept verbatim
    }
    i += 1;
  }

  return tokens;
}
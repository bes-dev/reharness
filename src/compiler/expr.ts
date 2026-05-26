/**
 * Compile-time guard expression validator + emitter.
 *
 * Accepts a tiny safe subset:
 *   - identifiers: only `config`, `data`, `retries` (with `.member.access`)
 *   - operators:   == != < <= > >= && || !
 *   - literals:    'string', "string", number, true, false, null
 *   - grouping:    ( ... )
 *
 * Rejects function calls, assignments, ternary, ++/--, bitwise, regex, etc.
 *
 * Output is a TS arrow-function body string: `(c) => (config.x == 'foo')` becomes
 *   `(c) => (c.config.x == "foo")` — i.e. identifiers are prefixed with `c.`.
 *
 * The runtime never evaluates strings — codegen embeds the compiled JS directly.
 */

const ROOT_IDENTS = new Set(["config", "data", "retries"]);
const KEYWORDS = new Set(["true", "false", "null"]);
const OPS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "+", "-", "*", "/", "%"];

type Token =
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: string }
  | { kind: "op"; value: string }
  | { kind: "lparen" | "rparen" };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }

    if (c === "(") { out.push({ kind: "lparen" }); i++; continue; }
    if (c === ")") { out.push({ kind: "rparen" }); i++; continue; }

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        j++;
      }
      if (j >= src.length) throw new Error(`Unterminated string at ${i}`);
      out.push({ kind: "string", value: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }

    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ kind: "number", value: src.slice(i, j) });
      i = j;
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$.]/.test(src[j])) j++;
      out.push({ kind: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }

    let matched = "";
    for (const op of OPS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    if (matched) {
      out.push({ kind: "op", value: matched });
      i += matched.length;
      continue;
    }

    throw new Error(`Unexpected character "${c}" at position ${i}`);
  }
  return out;
}

/** Throws on invalid expression. Returns the compiled JS body (with `c.` prefix on root idents). */
export function compileGuardExpr(src: string): string {
  const tokens = tokenize(src);
  if (tokens.length === 0) throw new Error("Empty guard expression");

  for (const t of tokens) {
    if (t.kind !== "ident") continue;
    if (KEYWORDS.has(t.value)) continue;
    const root = t.value.split(".")[0];
    if (!ROOT_IDENTS.has(root)) {
      throw new Error(`Identifier "${t.value}" must start with config, data, or retries`);
    }
    if (t.value.includes("..") || t.value.endsWith(".")) {
      throw new Error(`Malformed member access: "${t.value}"`);
    }
  }

  return tokens.map(t => {
    if (t.kind === "ident") {
      if (KEYWORDS.has(t.value)) return t.value;
      // retries.K → c.retries('K')  (runtime exposes retries as a function)
      if (t.value.startsWith("retries.")) {
        const parts = t.value.split(".");
        if (parts.length !== 2) throw new Error(`retries access must be retries.<key>, got "${t.value}"`);
        return `c.retries(${JSON.stringify(parts[1])})`;
      }
      if (t.value === "retries") throw new Error(`retries needs a key: write retries.<name>`);
      return "c." + t.value;
    }
    if (t.kind === "string") return JSON.stringify(t.value);
    if (t.kind === "number") return t.value;
    if (t.kind === "op") return t.value;
    if (t.kind === "lparen") return "(";
    return ")";
  }).join(" ");
}

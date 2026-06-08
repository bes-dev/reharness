import ts from "typescript";

export interface EntryFn { name: string; start: number; end: number; }

/**
 * Every top-level `export function <name>Entry` (sync or async) in a generated lib source, with the source
 * range of its declaration (JSDoc included), via the TS AST. `name` is the state name (the `Entry` suffix
 * stripped). Robust where line/substring scanning is not: a helper or `const` between or after entries, and a
 * comment or string that merely mentions `function fooEntry`, are never mistaken for an entry function.
 */
export function entryFunctions(source: string): EntryFn[] {
  const sf = ts.createSourceFile("lib.ts", source, ts.ScriptTarget.Latest, true);
  const out: EntryFn[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name) continue;
    if (!stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const m = /^(.+)Entry$/.exec(stmt.name.text);
    if (m) out.push({ name: m[1], start: stmt.getStart(sf, true), end: stmt.getEnd() });
  }
  return out;
}

/**
 * Drop the `export function <name>Entry` blocks whose <name> isn't live; returns the new source, or null if
 * nothing changed. Range-precise (AST): code between or after entries (helper functions, module-level consts,
 * comments) is preserved — unlike a line-scan that deletes everything from a dead entry up to the next
 * `export function`, silently taking any helper that happens to sit in between.
 */
export function pruneEntryFns(source: string, liveStates: Set<string>): string | null {
  const dead = entryFunctions(source).filter(f => !liveStates.has(f.name));
  if (dead.length === 0) return null;
  let out = source;
  for (const f of dead.sort((a, b) => b.start - a.start)) { // splice highest-first so earlier offsets stay valid
    let end = f.end;
    if (out[end] === "\n") end++; // absorb the declaration's terminating newline (no global rescan of strings)
    out = out.slice(0, f.start) + out.slice(end);
  }
  return out;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseSkeletonXML } from "../../src/compiler/xml.js";
import { toMermaid } from "../../src/compiler/visualize.js";

// A curated corpus of real compiled skeletons (a spread of topologies: parallel, loop, switch, approval, set,
// 0-agent, nested composites, legacy + current format) lives TRACKED under tests/fixtures so this runs in CI / a
// fresh clone. Sweeping the graph renderer over all of it is the regression net the `classDef call` bug slipped
// past — a single hand-picked skeleton missed the reserved-word collision. Locally it ALSO sweeps any compiled
// examples/ pipelines as a bonus (absent in a fresh clone).
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../fixtures/skeletons");
const EX = resolve(HERE, "../../examples");

function xmls(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".xml")).map(f => resolve(dir, f)) : [];
}

function corpus(): string[] {
  const out = xmls(FIXTURES); // tracked, CI-reproducible
  if (existsSync(EX)) for (const d of readdirSync(EX)) for (const sub of [".reharness/skeletons", "reharness/skeletons"]) {
    out.push(...xmls(resolve(EX, d, sub))); // local bonus coverage
  }
  return out;
}

// classDef names that would collide with a Mermaid keyword and break parsing — all of ours must be `st_`-prefixed.
const RESERVED_CLASS = /\bclassDef (call|end|class|click|graph|subgraph|style|linkStyle|default|state)\b/;

test("benchmark corpus: every compiled skeleton renders to structurally-valid Mermaid (flat + interactive)", () => {
  const files = corpus();
  assert.ok(files.length >= 8, `expected the tracked fixture corpus, found ${files.length}`);
  let checked = 0;
  for (const f of files) {
    let sk;
    try { sk = parseSkeletonXML(readFileSync(f, "utf-8")); } catch { continue; } // skip unparseable legacy fixtures
    for (const interactive of [false, true]) {
      const m = toMermaid(sk, interactive);
      assert.ok(m.startsWith("flowchart TD"), `${f}: missing flowchart header`);
      for (const name of Object.keys(sk.states)) assert.ok(m.includes(`"${name}"`), `${f}: no node for state '${name}'`);
      assert.ok(!RESERVED_CLASS.test(m), `${f}: a classDef collides with a Mermaid keyword`);
      assert.ok(!/:::(?!st_)/.test(m), `${f}: an inline class is not st_-prefixed`);
      assert.ok(!/\|"[^"]*[<>][^"]*"\|/.test(m), `${f}: raw <> in an edge label (must be entity-escaped)`);
      if (interactive) for (const name of Object.keys(sk.states)) assert.ok(m.includes("click "), `${f}: interactive mode emits click bindings`);
    }
    checked++;
  }
  assert.ok(checked >= 8, `parsed + rendered too few skeletons (${checked})`);
});

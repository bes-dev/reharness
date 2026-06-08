import { test } from "node:test";
import assert from "node:assert/strict";
import { toMermaid, toHtml } from "../../src/compiler/visualize.js";
import type { Skeleton } from "../../src/compiler/schema.js";

/** A skeleton exercising every routing kind: typed `on` + guards, code implicit-error, switch, parallel fork-join,
 *  and a loop whose step is ITSELF a parallel (nested composite). */
const sk: Skeleton = {
  id: "demo", description: "d", usage: "u", initial: "start",
  states: {
    start:  { type: "code", on: { DONE: "route" } },                               // implicit ERROR → error
    route:  { type: "switch", branches: [{ target: "fan", guard: "expr:x>0" }, { target: "done" }] },
    fan:    { type: "parallel", overExpr: "config.items", parallelBranch: "worker", join: "loop" },
    worker: { type: "agent", contract: "review one item" },
    loop:   { type: "loop", loopSteps: ["round"], maxIterations: 5, join: "done" },
    round:  { type: "parallel", overExpr: "config.items", parallelBranch: "rworker", join: "report" }, // nested: join ignored
    rworker:{ type: "agent" },
    report: { type: "code", on: { DONE: "done" } },
    done:   { type: "final", status: "success" },
    error:  { type: "final", status: "error" },
  },
};

test("toMermaid: a node per state, a START entry, classDefs", () => {
  const m = toMermaid(sk);
  assert.match(m, /^flowchart TD/);
  assert.match(m, /START --> n0/);                       // entry points at the initial state
  for (const name of Object.keys(sk.states)) assert.ok(m.includes(`"${name}"`), `node for ${name}`);
  assert.match(m, /classDef st_agent/);
  assert.match(m, /classDef st_fail/);                   // error final gets the fail class
});

test("toMermaid: class names are prefixed so they never collide with Mermaid keywords (e.g. `call`)", () => {
  const m = toMermaid(sk);
  // `classDef call …` is a parse error — `call` is reserved (`click X call f()`). All class names must be `st_…`.
  assert.match(m, /classDef st_call /);
  assert.ok(!/\bclassDef (call|end|class|click|graph|subgraph|style|linkStyle|default) /.test(m), "no reserved-word class name");
  assert.ok(!/:::(?!st_)/.test(m), "inline classes are prefixed too");
});

test("toMermaid: typed transitions, guards, code implicit-error", () => {
  const m = toMermaid(sk);
  assert.match(m, /-->\|"DONE"\|/);                      // labelled edge
  assert.match(m, /expr:x&gt;0/);                        // switch guard, `>` escaped
  assert.match(m, /-\.->\|"ERROR"\|/);                   // code with no explicit ERROR routes to error (dashed)
});

test("toMermaid: parallel fork-join + loop bound/exit", () => {
  const m = toMermaid(sk);
  assert.match(m, /-\.->\|"each item"\|/);               // parallel fan-out
  assert.match(m, /-->\|"fork-join"\|/);                 // fan → join
  assert.match(m, /-\.->\|"≤5"\|/);                      // loop bound
  assert.match(m, /-->\|"exit"\|/);                      // loop → join
});

test("toMermaid: a composite that is a loop step suppresses its own join (runtime-faithful)", () => {
  const m = toMermaid(sk);
  // `round` (parallel, a loop step) fans out to its branch but must NOT route to its own join `report`.
  // The only edge into `report` is the loop step-chain — `round` itself never emits a fork-join edge.
  const idOf = (n: string) => `n${Object.keys(sk.states).indexOf(n)}`;
  const edges = m.split("\n").filter(l => /-(\.|)->/.test(l));
  assert.ok(edges.some(l => l.startsWith(`  ${idOf("round")} -.->`)), "round fans out");
  assert.ok(!edges.some(l => l.startsWith(`  ${idOf("round")} -->|"fork-join"`)), "round emits no own join");
});

test("toHtml: self-contained, valid embedded node JSON, click bindings", () => {
  const html = toHtml(sk, { worker: "You review <one> item." });
  assert.match(html, /<pre class="mermaid">/);
  assert.match(html, /click n\d+ showNode/);             // interactive bindings
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/mermaid/);
  // the embedded __NODES__ payload must be valid JSON (escaping bugs would break the viewer)
  const json = html.match(/window\.__NODES__=(\{.*?\});<\/script>/s)![1];
  const nodes = JSON.parse(json) as Record<string, any>;
  assert.equal(Object.keys(nodes).length, Object.keys(sk.states).length);
  const worker = Object.values(nodes).find((n: any) => n.name === "worker") as any;
  assert.equal(worker.body, "You review <one> item.");   // leaf prompt threaded through, round-trips intact
  assert.equal(worker.contract, "review one item");
});

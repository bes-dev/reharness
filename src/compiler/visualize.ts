import type { Skeleton, SkeletonState } from "./schema.js";
import { computeRoles, visibleProducers } from "./analysis/graph.js";

// Render a compiled skeleton as a graph — a DETERMINISTIC pass, no model call. Two outputs share one topology:
//   • toMermaid  — a Mermaid `flowchart` string; renders inline on GitHub / in markdown (static, for docs).
//   • toHtml     — a self-contained interactive viewer (Mermaid does the layout, a click → side panel shows the
//                  node's contract / prompt / data-flow). The interactivity GitHub strips, served from our own page.
// The graph mirrors the runtime control flow: agent/code leaves, typed transitions+guards, and the composite
// constructs (parallel fork-join, bounded loop, switch routing) the runtime actually executes.

const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Mermaid node declaration — shape encodes the state type. */
function decl(id: string, name: string, type: SkeletonState["type"]): string {
  const t = esc(name);
  switch (type) {
    case "agent": return `${id}(["${t}"])`;
    case "approval": return `${id}{{"${t}"}}`;
    case "interactive": return `${id}[/"${t}"/]`;
    case "switch": return `${id}{"${t}"}`;
    case "parallel":
    case "loop":
    case "call": return `${id}[["${t}"]]`;
    case "wait": return `${id}>"${t}"]`;
    case "final": return `${id}(("${t}"))`;
    default: return `${id}["${t}"]`; // code, set
  }
}

// Class names are PREFIXED (`st_…`): several state types (`call`, …) collide with Mermaid reserved keywords
// (`click X call f()`), and a bare `classDef call …` is a parse error. The prefix sidesteps the whole keyword space.
const cssClass = (s: SkeletonState): string =>
  "st_" + (s.type === "final" ? (s.status === "error" ? "fail" : "final") : s.type);

interface Edge { from: string; to: string; label?: string; dashed?: boolean }

/** Derive control-flow edges from the graph — typed `on` transitions plus the composite structure (parallel
 *  fan-out + join, loop step-chain + bound, switch branches). Body states (parallel branch / loop steps) have
 *  their own `on` ignored by the runtime (they return to the parent's join), so we skip it — mirrors `successors`. */
function edges(sk: Skeleton): Edge[] {
  const { bodyStates } = computeRoles(sk);
  const has = (n?: string): n is string => !!n && !!sk.states[n];
  const E: Edge[] = [];
  const on = (from: string, st: SkeletonState) => {
    for (const [event, t] of Object.entries(st.on || {})) {
      if (typeof t === "string") { if (has(t)) E.push({ from, to: t, label: event }); }
      else for (const g of t) if (has(g.target)) E.push({ from, to: g.target, label: g.guard ? `${event} [${g.guard}]` : event });
    }
  };
  for (const [name, st] of Object.entries(sk.states)) {
    // A body state (parallel branch / loop step) still RUNS its body, but its routing OUT (own join/`on`) is
    // runtime-ignored — control returns to the parent's join. So draw the fan-out/step-chain, suppress the join.
    const isBody = bodyStates.has(name);
    if (st.type === "parallel") {
      if (has(st.parallelBranch)) E.push({ from: name, to: st.parallelBranch, label: "each item", dashed: true });
      if (has(st.join) && !isBody) E.push({ from: name, to: st.join, label: "fork-join" });
    } else if (st.type === "loop") {
      const steps = (st.loopSteps || []).filter(has);
      if (steps.length) {
        E.push({ from: name, to: steps[0], label: `≤${st.maxIterations ?? "max"}`, dashed: true });
        for (let i = 0; i < steps.length - 1; i++) E.push({ from: steps[i], to: steps[i + 1] });
        E.push({ from: steps[steps.length - 1], to: name, label: "next", dashed: true });
      }
      if (has(st.join) && !isBody) E.push({ from: name, to: st.join, label: "exit" });
    } else if (st.type === "switch") {
      for (const g of st.branches || []) if (has(g.target)) E.push({ from: name, to: g.target, label: g.guard || "else", dashed: true });
    }
    // `on`-transitions: active states only. Body states' `on` is runtime-ignored; switch routes via branches.
    if (!isBody && st.type !== "switch" && st.type !== "final") {
      on(name, st);
      if (st.type === "code" && !st.on?.["ERROR"] && has("error")) E.push({ from: name, to: "error", label: "ERROR", dashed: true });
    }
  }
  return E;
}

/** A Mermaid `flowchart` of the skeleton. `interactive` appends `click` bindings (HTML viewer only). */
export function toMermaid(sk: Skeleton, interactive = false): string {
  const names = Object.keys(sk.states);
  const id = new Map(names.map((n, i) => [n, `n${i}`]));
  const L: string[] = ["flowchart TD", "  START(( )):::st_start", `  START --> ${id.get(sk.initial)}`];

  for (const n of names) L.push("  " + decl(id.get(n)!, n, sk.states[n].type));
  for (const e of edges(sk)) {
    const arrow = e.dashed ? "-.->" : "-->";
    const lbl = e.label ? `${arrow}|"${esc(e.label)}"|` : arrow;
    L.push(`  ${id.get(e.from)} ${lbl} ${id.get(e.to)}`);
  }

  const byClass = new Map<string, string[]>();
  for (const n of names) (byClass.get(cssClass(sk.states[n])) ?? byClass.set(cssClass(sk.states[n]), []).get(cssClass(sk.states[n]))!).push(id.get(n)!);
  L.push(...CLASSDEFS);
  for (const [cls, ids] of byClass) L.push(`  class ${ids.join(",")} ${cls}`);
  if (interactive) for (const n of names) L.push(`  click ${id.get(n)} showNode`);
  return L.join("\n");
}

const CLASSDEFS = [
  "  classDef st_agent fill:#dbeafe,stroke:#2563eb,color:#1e3a8a",
  "  classDef st_code fill:#f1f5f9,stroke:#64748b,color:#0f172a",
  "  classDef st_set fill:#f1f5f9,stroke:#64748b,color:#0f172a",
  "  classDef st_approval fill:#fef9c3,stroke:#ca8a04,color:#713f12",
  "  classDef st_interactive fill:#fef9c3,stroke:#ca8a04,color:#713f12",
  "  classDef st_switch fill:#ede9fe,stroke:#7c3aed,color:#4c1d95",
  "  classDef st_parallel fill:#dcfce7,stroke:#16a34a,color:#14532d",
  "  classDef st_loop fill:#dcfce7,stroke:#16a34a,color:#14532d",
  "  classDef st_call fill:#cffafe,stroke:#0891b2,color:#164e63",
  "  classDef st_wait fill:#fae8ff,stroke:#c026d3,color:#701a75",
  "  classDef st_final fill:#dcfce7,stroke:#16a34a,color:#14532d",
  "  classDef st_fail fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
  "  classDef st_start fill:#0f172a,stroke:#0f172a,color:#fff",
];

/** Per-node detail for the interactive panel — derived from the skeleton + (optional) leaf bodies (prompts/code). */
function nodeDetail(sk: Skeleton, name: string, roles: ReturnType<typeof computeRoles>, body?: string) {
  const st = sk.states[name];
  const trans: { event: string; target: string; guard?: string }[] = [];
  for (const [event, t] of Object.entries(st.on || {})) {
    if (typeof t === "string") trans.push({ event, target: t });
    else for (const g of t) trans.push({ event, target: g.target, guard: g.guard });
  }
  for (const g of st.branches || []) trans.push({ event: "when", target: g.target, guard: g.guard || "else" });
  const isBody = roles.bodyStates.has(name);
  const inputs = (st.type === "agent" || st.type === "code" || st.type === "interactive") && !isBody
    ? visibleProducers(sk, name, roles) : undefined;
  return {
    name, type: st.type, status: st.status, contract: st.contract,
    trans,
    over: st.overExpr, branch: st.parallelBranch, join: st.join, steps: st.loopSteps, max: st.maxIterations,
    reads: st.reads, writes: st.writes,
    inputs: inputs && (inputs.single.length || inputs.list.length) ? inputs : undefined,
    body,
  };
}

/** A self-contained interactive viewer (single HTML file). `bodies` maps state name → its prompt/code text (for the
 *  click panel); omit for a skeleton-only graph. Mermaid is loaded from a CDN — open in any browser, nothing to install. */
export function toHtml(sk: Skeleton, bodies: Record<string, string> = {}): string {
  const roles = computeRoles(sk);
  const id = new Map(Object.keys(sk.states).map((n, i) => [n, `n${i}`]));
  const nodes: Record<string, ReturnType<typeof nodeDetail>> = {};
  for (const n of Object.keys(sk.states)) nodes[id.get(n)!] = nodeDetail(sk, n, roles, bodies[n]);
  const data = JSON.stringify(nodes).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>reharness · ${esc(sk.id)}</title>
<style>
  :root{--bg:#fff;--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--accent:#2563eb}
  *{box-sizing:border-box} body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
  header{padding:14px 20px;border-bottom:1px solid var(--line)} header b{font-size:16px} header span{color:var(--mut);margin-left:8px}
  #wrap{display:flex;height:calc(100vh - 53px)}
  #graph{flex:1;overflow:auto;padding:24px;background:#f8fafc}
  #panel{width:380px;border-left:1px solid var(--line);overflow:auto;padding:18px 20px}
  #panel h2{margin:0 0 2px;font-size:15px} #panel .t{display:inline-block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin-bottom:14px}
  #panel h3{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:16px 0 6px;border-top:1px solid var(--line);padding-top:14px}
  #panel .hint{color:var(--mut)} pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;border:1px solid var(--line);border-radius:6px;padding:10px;margin:0;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
  .tr{display:flex;gap:6px;align-items:baseline;margin:3px 0} .tr code{color:var(--accent);font-weight:600} .tr .g{color:var(--mut);font-size:12px}
  ul{margin:4px 0;padding-left:18px} li{margin:2px 0}
  .mermaid{font-size:14px} .mermaid .node{cursor:pointer}
</style></head>
<body>
<header><b>reharness · ${esc(sk.id)}</b><span>${esc(sk.description || "")}</span></header>
<div id="wrap">
  <div id="graph"><pre class="mermaid">${toMermaid(sk, true)}</pre></div>
  <aside id="panel"><p class="hint">Click any node to inspect its contract, prompt, transitions and data flow.</p></aside>
</div>
<script>window.__NODES__=${data};</script>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
const P=document.getElementById("panel"), E=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
window.showNode=(gid)=>{
  const d=window.__NODES__[gid]; if(!d) return;
  let h='<h2>'+E(d.name)+'</h2><div class="t">'+E(d.type)+(d.status?" · "+E(d.status):"")+'</div>';
  if(d.contract) h+='<h3>Contract</h3><pre>'+E(d.contract)+'</pre>';
  if(d.over) h+='<h3>Fan-out over</h3><pre>'+E(d.over)+'</pre>';
  if(d.steps) h+='<h3>Loop</h3><div>steps: '+d.steps.map(E).join(" → ")+(d.max?' · ≤'+d.max+' iter':'')+'</div>';
  if(d.inputs){ h+='<h3>Reads (derived)</h3><ul>'+
    d.inputs.single.map(s=>'<li>'+E(s)+'</li>').join("")+
    d.inputs.list.map(s=>'<li>'+E(s)+' <span class="hint">(list)</span></li>').join("")+'</ul>'; }
  if(d.reads&&d.reads.length) h+='<h3>data reads</h3><div>'+d.reads.map(E).join(", ")+'</div>';
  if(d.writes&&d.writes.length) h+='<h3>data writes</h3><div>'+d.writes.map(E).join(", ")+'</div>';
  if(d.trans&&d.trans.length){ h+='<h3>Transitions</h3>'+d.trans.map(t=>
    '<div class="tr"><code>'+E(t.event)+'</code> → '+E(t.target)+(t.guard?' <span class="g">['+E(t.guard)+']</span>':'')+'</div>').join(""); }
  if(d.body) h+='<h3>'+(d.type==="agent"?"Prompt":"Implementation")+'</h3><pre>'+E(d.body)+'</pre>';
  P.innerHTML=h;
};
mermaid.initialize({startOnLoad:true,securityLevel:"loose",theme:"neutral",flowchart:{useMaxWidth:false}});
</script>
</body></html>`;
}

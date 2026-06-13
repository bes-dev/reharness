import type { Skeleton } from "../schema.js";
import { computeRoles, visibleProducers } from "./graph.js";

/**
 * Static optimization-opportunity report — the FACTS that ground a cost-aware `optimize` pass (no runs, no LLM,
 * no model internals; an instance over the existing `visibleProducers` engine, per analysis.md invariant). It
 * surfaces, from the skeleton alone, where inference cost can be cut at equal-or-better quality (the two-floor
 * theory: minimal-sufficient context Pareto-dominates "everything just in case"; a dead/redundant production is
 * pure waste). It does NOT decide need-to-know pruning or agent→code demotion — those are judgment the `optimize`
 * agent makes by reading contracts; this report tells it WHERE to look.
 *
 *  - contextSurface  — per consumer leaf, the producer dirs the runtime injects = its cost surface AND its
 *                      information-leak surface (everything it MAY see). High surface ⇒ a need-to-know slicing
 *                      / isolation candidate (the test-agent-sees-impl class).
 *  - fanOut          — per producer, the consumers that see it. High fan-out ⇒ a CSE/hoist candidate (many leaves
 *                      re-process the same upstream output) and a broad leak surface.
 *  - deadProducers   — a producer no consumer sees and that is not a terminal deliverable ⇒ pure waste candidate.
 *  - cost            — a coarse STRUCTURAL proxy (agent leaves × context edges) to measure an optimization delta
 *                      before/after a transform. NOT a token estimate (volumes are runtime); a relative score.
 */
export interface OptReport {
  contextSurface: { name: string; type: string; visible: string[] }[];
  fanOut: { producer: string; consumers: string[] }[];
  highFanIn: { producer: string; consumers: string[] }[];
  deadProducers: string[];
  /** Per AGENT leaf, the visible producers whose stage name its CONTRACT never mentions = need-to-know slicing
   *  candidates (cost + leak + distraction). DERIVED from the contract (an existing LLM-authored artifact — like
   *  configFlowErrors scans guards), NOT a declaration: `visibleProducers` is unchanged, so invariant #1 holds.
   *  HEURISTIC (a contract may reference a producer by its artifact filename, not stage name) → a CANDIDATE the
   *  `optimize` agent adjudicates by reading the contract, never an auto-cut (under-cut would starve a leaf). */
  overShare: { leaf: string; unreferenced: string[] }[];
  cost: { agentLeaves: number; contextEdges: number; agentContextEdges: number; avgSurfacePerAgent: number };
}

const CONSUMES = new Set(["agent", "code", "interactive"]); // states whose entry reads injected producer dirs

export function optimizationReport(sk: Skeleton): OptReport {
  const roles = computeRoles(sk);
  const names = Object.keys(sk.states);
  const consumers = names.filter(n => CONSUMES.has(sk.states[n].type));

  // consumer → its visible producer dirs (single + list); the order is irrelevant for these aggregates.
  const visible = new Map<string, string[]>();
  for (const c of consumers) { const v = visibleProducers(sk, c, roles); visible.set(c, [...v.single, ...v.list]); }

  // producer → consumers that can see it (fan-out).
  const fan = new Map<string, string[]>();
  for (const [c, prods] of visible) for (const p of prods) {
    const arr = fan.get(p); if (arr) arr.push(c); else fan.set(p, [c]);
  }

  // A producer-typed state with no consumer AND whose own successors include a final is a terminal deliverable
  // (expected to be unread) — exclude it; anything else unread is a dead-production candidate.
  const terminal = new Set(names.filter(n =>
    (sk.states[n].on ? Object.values(sk.states[n].on as any).flat() : []).some((t: any) =>
      sk.states[typeof t === "string" ? t : t?.target]?.type === "final")));
  const deadProducers = consumers.filter(p => !fan.has(p) && !terminal.has(p));

  const contextSurface = consumers
    .map(name => ({ name, type: sk.states[name].type, visible: visible.get(name) ?? [] }))
    .sort((a, b) => b.visible.length - a.visible.length);
  const fanOut = [...fan].map(([producer, cs]) => ({ producer, consumers: cs }))
    .sort((a, b) => b.consumers.length - a.consumers.length);
  const highFanIn = fanOut.filter(f => f.consumers.length >= 2);

  const agentLeaves = names.filter(n => sk.states[n].type === "agent");

  // Contract-derived over-share: a producer visible to an agent whose contract never names it is a slicing candidate.
  const overShare = agentLeaves.map(leaf => {
    const contract = (sk.states[leaf].contract ?? "").toLowerCase();
    const unreferenced = (visible.get(leaf) ?? []).filter(p => !contract.includes(p.toLowerCase()));
    return { leaf, unreferenced };
  }).filter(o => o.unreferenced.length).sort((a, b) => b.unreferenced.length - a.unreferenced.length);

  const contextEdges = [...visible.values()].reduce((s, v) => s + v.length, 0);
  const agentContextEdges = agentLeaves.reduce((s, a) => s + (visible.get(a)?.length ?? 0), 0);

  return {
    contextSurface, fanOut, highFanIn, deadProducers, overShare,
    cost: {
      agentLeaves: agentLeaves.length,
      contextEdges,
      agentContextEdges,
      avgSurfacePerAgent: agentLeaves.length ? +(agentContextEdges / agentLeaves.length).toFixed(1) : 0,
    },
  };
}

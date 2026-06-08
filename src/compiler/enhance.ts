import { existsSync, readdirSync, rmSync } from "fs";
import { resolve, dirname, relative } from "path";
import { fileURLToPath } from "url";
import { definePipeline } from "../runtime/fsm.js";
import type { Pipeline } from "../runtime/types.js";
import { agentLeaves, type LeafRef } from "./project-fs.js";
import { COMPILER_CONCURRENCY } from "../config.js";
import { layout } from "../layout.js";
import { verifyHarness, snapshotBase, restoreBase, type HarnessReport } from "./verify-harness.js";

const BUILTIN_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "agents");

/**
 * The enhance layer as its own self-hosted FSM (NOT a tail node on /generate). It strengthens each agent leaf
 * of an already-verified pipeline with a per-leaf harness, then GATES the result the same way the base is gated
 * by `verify` — and degrades gracefully: a bad harness is discarded, never failing the verified base.
 *
 * Flow: plan_leaves (snapshot base) → harness (parallel, one isolated branch per leaf, web-research) →
 *       verify_harness (deterministic gate) → PASS: done | FAIL: reconcile (discard bad + restore base) → done.
 * The error terminal is reserved for genuine internal faults; harness problems never reach it (the base runs
 * without any harness — invariant). Most leaves get no harness; that is the expected outcome.
 */
export function buildEnhancePipeline(target: string, command = ""): Pipeline {
  const L = layout(target);
  const skeletonsDir = L.skeletons;
  const snapshotDir = resolve(L.scratch, ".base-snapshot");

  // Scope to the just-compiled command (separate compilation: enhancing B must not re-run the harness_leaf
  // agent on A's already-enhanced leaves — that is wasteful and a non-deterministic disturbance of a sibling).
  const collectLeaves = (): LeafRef[] => agentLeaves(skeletonsDir, command);

  return definePipeline({
    config: { target },
    agents: BUILTIN_AGENTS_DIR,
    cwd: target,
    logsDir: L.runs,
    initial: "plan_leaves",

    states: {
      plan_leaves: {
        entry: async (c) => {
          const leaves = collectLeaves();
          c.data.leaves = leaves;
          if (!leaves.length) { c.emit("→ enhance: no agent leaves"); return "EMPTY"; }
          snapshotBase(target, snapshotDir);
          c.emit(`→ enhance: ${leaves.length} leaf(leaves) — ${leaves.map(l => l.name).join(", ")}`);
          return "DONE";
        },
        on: { DONE: "harness", EMPTY: "done" },
      },

      // Fan out: one isolated branch per leaf (no single-context degradation on big pipelines; research in parallel).
      harness: { type: "parallel", over: (c) => c.data.leaves, branch: "harness_leaf", join: "verify_harness", concurrency: COMPILER_CONCURRENCY },

      harness_leaf: {
        entry: async (c) => {
          const leaf = c.branchInput as LeafRef;
          const skillsDir = L.skills;
          const available = existsSync(skillsDir) ? readdirSync(skillsDir).filter(f => f.endsWith(".md")) : [];
          const dir = `reharness/agents/${leaf.skeletonId}/${leaf.name}`; // agents are namespaced per command
          const skillRef = relative(dir, "reharness/skills"); // DERIVED depth (leaf dir → skills/) — never hand-counted
          const skillsNote = available.length
            ? `Available domain-skills in reharness/skills/ (attach the relevant one(s) as "${skillRef}/<file>"): ${available.join(", ")}.`
            : `No domain-skills exist yet; research a new one ONLY if this leaf genuinely needs domain knowledge.`;
          await c.agent("harness_leaf",
            `Attach the right domain-skill(s) to exactly ONE agent leaf: '${leaf.name}'.\n` +
            `Its finished prompt is at ${dir}/SYSTEM.md and its <contract> is in ` +
            `reharness/skeletons/${leaf.skeletonId}.xml. ${skillsNote} Prefer ATTACHING an existing skill; ` +
            `research a NEW one only for a real gap (never from memory). Write ONLY ${dir}/harness.json ` +
            `(and, for a gap, a new reharness/skills/<topic>.md). If the leaf needs nothing, write nothing — the common outcome.`);
        },
        on: {},
      },

      // Deterministic gate — symmetric to the base's `verify`. Detection only (reconcile mutates).
      verify_harness: {
        entry: async (c) => {
          const report = verifyHarness(target);
          c.data.harnessReport = report;
          const bad = report.leaves.filter(l => !l.ok);
          if (!bad.length && !report.baseChanged.length) { c.emit("✓ harness verified"); return "PASS"; }
          c.emit(`⚠ harness issues — ${bad.length} leaf(leaves)` + (report.baseChanged.length ? `, ${report.baseChanged.length} base file(s) modified` : ""));
          return "FAIL";
        },
        on: { PASS: "done", FAIL: "reconcile" },
      },

      // Graceful degradation: drop invalid harnesses, restore any touched base file — the verified base stays intact.
      reconcile: {
        entry: async (c) => {
          const report = c.data.harnessReport as HarnessReport;
          for (const l of report.leaves) if (!l.ok) {
            for (const f of l.badFiles) rmSync(f, { force: true });
            c.emit(`✗ harness dropped for '${l.name}': ${l.reason}`);
          }
          if (report.baseChanged.length) {
            restoreBase(target, snapshotDir, report.baseChanged);
            c.emit(`↺ restored ${report.baseChanged.length} base file(s) modified during enhance`);
          }
        },
        on: "done",
      },

      done: {
        type: "final", status: "success",
        entry: async (c) => {
          const report = c.data.harnessReport as HarnessReport | undefined;
          const kept = report ? report.leaves.filter(l => l.ok && l.hasHarness).map(l => l.name) : [];
          c.emit(kept.length ? `✓ enhance done — harness applied to: ${kept.join(", ")}` : "✓ enhance done (no harness needed)");
        },
      },
      error: { type: "final", status: "error" },
    },
  });
}

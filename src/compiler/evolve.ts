import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "fs";
import { resolve, dirname, relative } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { definePipeline } from "../runtime/fsm.js";
import type { Pipeline } from "../runtime/types.js";
import type { SavedState } from "../runtime/persistence.js";
import { parseSkeletonXML } from "./xml.js";
import { verifyGenerated } from "./verify.js";
import { COMPILER_CONCURRENCY, CORRECTION_RETRIES } from "../config.js";
import { generateAllFromSkeletons, emitCompiledFromSkeletonsDir } from "./codegen.js";
import { loadSkeletons, commandAgentsDir, agentLeaves as listAgentLeaves, readJSON, type LeafRef } from "./project-fs.js";
import { validateSkeleton, validateContracts, configFlowErrors } from "./analysis/index.js";
import { loadProject } from "../runtime/project.js";
import { findLeafTrace } from "../runtime/trace.js";
import { verifyTool } from "./evolve-gate.js";
import { allProviders } from "../runtime/providers.js";
import { layout, BUNDLE_DIR } from "../layout.js";
import { loadLedger, saveLedger, recordBind, updateLedger, retentionTrim } from "./evolve-ledger.js";

const BUILTIN_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "agents");

/** The terminal verdict `evolve` reads from a run's state.json — the runtime's own persisted shape (no re-declaration). */
type Verdict = SavedState;

/**
 * `evolve` — the dynamic amortization layer (see .claude/theory/evolve.md). It reads the LAST run's persisted
 * verdict and gives every run a verdict, then acts only when warranted:
 *  - Track 2 (self-heal): a failed/degraded run → diagnose + repair the LEAF (reflective trace-driven repair),
 *    keeping the skeleton's <contract> the source of truth; an unfixable-at-the-leaf fault escalates to `replan`
 *    (auto-redesign) → construct → fill_changed → re-verify, then `confirm_rerun` re-runs the command.
 *  - Track 1 (amortization): a successful run → refine attached skills, and extract a repeated deterministic
 *    routine into a Pi tool, gated by acquisition (verifyTool) + retention (the utility ledger).
 */
export function buildEvolvePipeline(target: string, command = "", runOpts: { provider?: string; piModel?: string } = {}): Pipeline {
  const L = layout(target);
  const reharnessDir = L.root; // bundle root (kept as an alias so the ledger/tools/agents helpers below read naturally)
  const skeletonsDir = L.skeletons;
  const escalatePath = resolve(L.evolve, "needs-redesign.md");

  /** The command a run belongs to — the skeleton whose states cover the run's traced stages (multi-command). */
  const commandOf = (runDir: string): string => {
    const traceRoot = resolve(runDir, "trace");
    if (!existsSync(traceRoot)) return "";
    const stages = readdirSync(traceRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    if (!stages.length) return "";
    // A run executes ONE command, so its traced stages are a subset of that command's states. Match the skeleton
    // that covers them ALL (not just any one) — `.every` disambiguates commands that happen to share a stage name.
    return loadSkeletons(skeletonsDir).find(sk => stages.every(st => sk.states[st]))?.id ?? "";
  };

  /** The latest pipeline EXECUTION run (optionally of a specific `command`). Compiled commands log to
   *  `<target>/<slug>/logs/run-*` — NOT `reharness/.cache/runs` (meta-runs). run-ids are sortable timestamps. */
  const latestRun = (): string | null => {
    let best: string | null = null, bestId = "";
    for (const child of existsSync(target) ? readdirSync(target, { withFileTypes: true }) : []) {
      if (!child.isDirectory() || child.name === BUNDLE_DIR || child.name === "node_modules") continue;
      const cLogs = resolve(target, child.name, "logs");
      if (!existsSync(cLogs)) continue;
      for (const run of readdirSync(cLogs).filter(d => d.startsWith("run-"))) {
        const runDir = resolve(cLogs, run);
        if (command && commandOf(runDir) !== command) continue; // `evolve <cmdId>`: only this command's runs
        if (run > bestId) { bestId = run; best = runDir; }
      }
    }
    return best;
  };
  const readVerdict = (runDir: string): Verdict | null => readJSON<Verdict | null>(resolve(runDir, "state.json"), null);
  /** The skeleton id whose states include `stage` (the run is of one compiled command). */
  const skeletonForStage = (stage: string): string =>
    loadSkeletons(skeletonsDir).find(sk => sk.states[stage])?.id ?? "";
  /** Agent leaves of one command (cmdId) — or all, if cmdId is empty. One tool-extraction branch per leaf. */
  const agentLeaves = (cmdId: string): LeafRef[] => listAgentLeaves(skeletonsDir, cmdId);
  /** Deterministic in-session validator for the replan agent: parse + lint + contract-coverage every skeleton. */
  const skeletonErrors = (): string[] => {
    if (!existsSync(skeletonsDir)) return ["no skeletons to validate"];
    const errs: string[] = [];
    for (const f of readdirSync(skeletonsDir).filter(f => f.endsWith(".xml"))) {
      try {
        const sk = parseSkeletonXML(readFileSync(resolve(skeletonsDir, f), "utf-8"));
        errs.push(...validateSkeleton(sk), ...validateContracts(sk), ...configFlowErrors(sk));
      } catch (e: any) { errs.push(`XML parse error in ${f}: ${e.message}`); }
    }
    return errs;
  };

  return definePipeline({
    config: { target },
    agents: BUILTIN_AGENTS_DIR,
    cwd: target,
    logsDir: L.runs, // evolve's OWN meta-run logs (the executions it reads live in each run's target dir)
    initial: "read_verdict",

    states: {
      read_verdict: {
        entry: async (c) => {
          rmSync(escalatePath, { force: true }); // clear any stale escalation from a prior evolve
          const runDir = latestRun();
          if (!runDir) { c.emit("→ evolve: no runs to learn from"); return "NONE"; }
          const v = readVerdict(runDir);
          if (!v || !v.status) { c.emit("→ evolve: latest run has no verdict (interrupted / pre-verdict) — re-run the pipeline"); return "NONE"; }
          if (v.status === "success") {
            // Succeeded but DEGRADED (a stage swallowed a best-effort failure via c.warn): repair the leaf so
            // the feature actually works — heal, with the same pointers as an error verdict but a softer framing.
            if (v.warnings?.length) {
              const stage = v.warnings[0].stage;
              c.data.failedStage = stage;
              c.data.reason = v.warnings.map(w => w.message).join("; ");
              c.data.skeletonId = skeletonForStage(stage);
              c.data.errorTxtPath = "";
              c.data.failRunDir = runDir;
              c.data.argv = Array.isArray(v.argv) ? v.argv : undefined;
              c.data.degraded = true;
              c.emit(`⚠ last run succeeded but DEGRADED at '${stage}': ${c.data.reason} → heal`);
              return "HEAL";
            }
            const leaves = agentLeaves(commandOf(runDir)); // only the leaves of the command that ran
            if (!leaves.length) { c.emit("✓ stable — last run succeeded; no agent leaves to learn from"); return "STABLE"; }
            c.data.leaves = leaves;
            c.data.successRunDir = runDir;
            c.emit(`✓ last run succeeded — scanning ${leaves.length} leaf(leaves) for a repeatable routine to amortize`);
            return "FEEDBACK";
          }
          // error verdict → record pointers for heal
          const stage = v.failedStage || "";
          const errTxt = stage ? resolve(runDir, "work", stage, "error.txt") : "";
          c.data.failedStage = stage;
          c.data.reason = typeof v.data?.error === "string" ? v.data.error : "";
          c.data.skeletonId = stage ? skeletonForStage(stage) : "";
          c.data.errorTxtPath = errTxt && existsSync(errTxt) ? errTxt : "";
          c.data.failRunDir = runDir;
          c.data.argv = Array.isArray(v.argv) ? v.argv : undefined; // for confirm_rerun
          c.emit(`✗ last run failed at '${stage}'${c.data.reason ? `: ${c.data.reason}` : ""} → heal`);
          return "HEAL";
        },
        on: { STABLE: "stable", HEAL: "heal", FEEDBACK: "refine_skills", NONE: "noop" },
      },

      // Success-branch feedback, two passes over the trace. First: refine attached domain-skills where the run
      // revealed they misled (skills-from-experience). Then: extract repeated mechanical routines into tools.
      refine_skills: { type: "parallel", over: (c) => c.data.leaves, branch: "refine_leaf", join: "extract", concurrency: COMPILER_CONCURRENCY },

      refine_leaf: {
        entry: async (c) => {
          const leaf = c.branchInput as LeafRef;
          const runDir = c.data.successRunDir as string;
          const hp = resolve(commandAgentsDir(reharnessDir, leaf.skeletonId), leaf.name, "harness.json");
          const skills = readJSON<{ skills?: string[] }>(hp, {}).skills ?? [];
          if (!skills.length) return; // no attached skill to refine
          const logFile = findLeafTrace(runDir, leaf.name);
          if (!logFile) return;
          await c.agent("refine_skill",
            `Leaf '${leaf.name}' ran successfully. Check whether its attached domain-skill(s) misled it (a wrong/stale ` +
            `detail it had to correct or work around at runtime), and if so sharpen the skill — researching any fact you change.\n` +
            `- trace log: ${logFile};\n` +
            `- attached skill(s) (paths relative to reharness/agents/${leaf.skeletonId}/${leaf.name}/): ${skills.join(", ")} (i.e. under reharness/skills/).\n` +
            `If the skill was fine, change nothing — the common outcome.`);
        },
        on: {},
      },

      // One isolated branch per agent leaf looks for a repeated mechanical routine to amortize into a tool
      // (EBL extraction; value from N=1). Most leaves yield nothing — that is expected.
      extract: { type: "parallel", over: (c) => c.data.leaves, branch: "extract_leaf", join: "reconcile_tools", concurrency: COMPILER_CONCURRENCY },

      extract_leaf: {
        entry: async (c) => {
          const leaf = c.branchInput as LeafRef;
          const runDir = c.data.successRunDir as string;
          const logFile = findLeafTrace(runDir, leaf.name);
          if (!logFile) return; // this leaf didn't run in the latest trace — nothing to learn
          await c.agent("extract_tool",
            `Analyse the execution trace of agent leaf '${leaf.name}' for a single repeated, deterministic, MECHANICAL ` +
            `sub-routine to amortize into a tool.\n` +
            `- trace log: ${logFile} ([thinking]/[tool]/[response]);\n` +
            `- the leaf's prompt: reharness/agents/${leaf.skeletonId}/${leaf.name}/SYSTEM.md; its contract: reharness/skeletons/${leaf.skeletonId}.xml.\n` +
            `If you find one, write it as <name>.routine.mjs (a neutral routine: export { tool, run }) + <name>.test.mjs ` +
            `to YOUR OUTPUT DIRECTORY (the workspace dir named in your task), where <name> == tool.name. If there is no ` +
            `clearly-repeated mechanical routine, write nothing — the common outcome.`);
        },
        on: {},
      },

      // Acquisition gate + bind. For each extracted tool: verifyTool (parse/structure/substrate/self-test) → if it
      // passes, bind it to its leaf's harness.json `extensions` (loadHarness lowers it to `pi --extension` next run);
      // else drop it. Graceful: a bad tool never fails the project (same posture as verify_harness).
      reconcile_tools: {
        entry: async (c) => {
          const ledger = loadLedger(reharnessDir);
          let bound = 0, dropped = 0;
          // Harvest tools the extract branches wrote to their own output dirs (the workspace each agent writes to),
          // verify each, then relocate the survivors into reharness/tools/<leaf>/ and bind them.
          const branches = (c.data.branches as Array<{ input?: any; dir?: string; ok?: boolean }> | undefined) || [];
          for (const b of branches) {
            const leaf = b.input?.name as string | undefined;
            const cmdId = b.input?.skeletonId as string | undefined;
            if (!b.ok || !b.dir || !leaf || !cmdId || !existsSync(b.dir)) continue;
            for (const f of readdirSync(b.dir).filter(f => f.endsWith(".routine.mjs"))) {
              const src = resolve(b.dir, f);
              const leafDir = resolve(commandAgentsDir(reharnessDir, cmdId), leaf);
              const destDir = resolve(L.tools, cmdId, leaf);
              const ref = relative(leafDir, resolve(destDir, f)); // ref to the NEUTRAL routine; the runtime backend lowers it to its variant
              if (ledger.tools[ref]) continue; // already bound in a prior cycle
              const errs = verifyTool(src); // its <name>.test.mjs sits beside it in the branch dir
              if (errs.length) { c.emit(`✗ tool '${leaf}/${f}' rejected: ${errs[0]}`); dropped++; continue; }
              // read the neutral descriptor; enforce filename stem === tool.name (the runtime derives tool ids from the path)
              let tool: { name?: string; schema?: unknown } | undefined;
              try { tool = (await import(pathToFileURL(src).href)).tool; } catch { c.emit(`✗ tool '${leaf}/${f}' rejected: routine import failed`); dropped++; continue; }
              const stem = f.replace(/\.routine\.mjs$/, "");
              if (!tool?.name || !tool?.schema) { c.emit(`✗ tool '${leaf}/${f}' rejected: tool descriptor missing name/schema`); dropped++; continue; }
              if (tool.name !== stem) { c.emit(`✗ tool '${leaf}/${f}' rejected: file must be named <tool.name>.routine.mjs (name=${tool.name})`); dropped++; continue; }
              // relocate the routine (+ its self-test), then render EVERY backend's wrapper beside it (any backend may run the command later)
              mkdirSync(destDir, { recursive: true });
              copyFileSync(src, resolve(destDir, f));
              const srcTest = src.replace(/\.routine\.mjs$/, ".test.mjs");
              if (existsSync(srcTest)) copyFileSync(srcTest, resolve(destDir, f.replace(/\.routine\.mjs$/, ".test.mjs")));
              for (const p of allProviders()) for (const v of p.renderTool(f)) writeFileSync(resolve(destDir, v.name), v.content);
              // bind: the leaf's harness.json extensions reference the NEUTRAL routine
              const hp = resolve(leafDir, "harness.json");
              const h = readJSON<{ extensions?: string[] }>(hp, {});
              const exts: string[] = Array.isArray(h.extensions) ? h.extensions : [];
              if (!exts.includes(ref)) exts.push(ref);
              h.extensions = exts;
              mkdirSync(leafDir, { recursive: true });
              writeFileSync(hp, JSON.stringify(h, null, 2) + "\n");
              recordBind(ledger, ref, leaf, tool.name, cmdId);
              c.emit(`✓ tool '${tool.name}' bound to leaf '${leaf}'`); bound++;
            }
          }
          saveLedger(reharnessDir, ledger);
          c.data.bound = bound;
          if (dropped) c.emit(`  (${dropped} candidate(s) rejected by the acquisition gate)`);
          return "DONE";
        },
        on: "update_ledger",
      },

      // Utility accounting + retention (the second gate stage). Count tool-calls in the latest trace, then trim
      // bound tools that don't earn their place (TroVE/Minton) — keeps the library from bloating the runtime.
      update_ledger: {
        entry: async (c) => {
          const ledger = loadLedger(reharnessDir);
          updateLedger(ledger, c.data.successRunDir as string);
          saveLedger(reharnessDir, ledger);
          return "DONE";
        },
        on: "retention_trim",
      },

      retention_trim: {
        entry: async (c) => {
          const ledger = loadLedger(reharnessDir);
          const trimmed = retentionTrim(ledger, reharnessDir);
          saveLedger(reharnessDir, ledger);
          for (const ref of trimmed) c.emit(`↓ tool '${ref}' unbound (low utility) — archived`);
          const changed = (c.data.bound as number) > 0 || trimmed.length > 0;
          c.emit(changed ? `✓ evolve: ${c.data.bound || 0} amortized, ${trimmed.length} retired` : "✓ evolve: stable (no tool changes)");
          return changed ? "IMPROVED" : "STABLE";
        },
        on: { IMPROVED: "improved", STABLE: "stable" },
      },

      heal: {
        entry: async (c) => {
          const stage = c.data.failedStage as string, id = c.data.skeletonId as string;
          const reason = c.data.reason as string, errTxt = c.data.errorTxtPath as string, runDir = c.data.failRunDir as string;
          const degraded = !!c.data.degraded;
          mkdirSync(L.evolve, { recursive: true }); // ensure the escalation dir exists before heal may write needs-redesign.md
          await c.agent("heal",
            (degraded
              ? `A run of this pipeline SUCCEEDED but DEGRADED at the '${stage}' stage — it swallowed a best-effort failure${reason ? `: ${reason}` : ""}. Make the feature actually work.\n`
              : `A run of this pipeline FAILED at the '${stage}' stage${reason ? ` with: ${reason}` : ""}.\n`) +
            `Diagnose the ROOT CAUSE from the failure and fix it in the LEAF, keeping the stage's <contract> UNCHANGED:\n` +
            `- the failing stage's <contract> is in reharness/skeletons/${id}.xml (state '${stage}');\n` +
            `- code states: reharness/lib/${id}-states.ts (function \`${stage}Entry\`); agent leaves: reharness/agents/${id}/${stage}/SYSTEM.md;\n` +
            (errTxt ? `- the stage wrote an error to ${errTxt};\n` : ``) +
            `- the failed run dir is ${runDir} — its work/<stage>/ holds each stage's output for inspection.\n` +
            `Fix ONLY the leaf (the lib function or the agent SYSTEM.md). If the fix genuinely needs a topology/contract ` +
            `change you cannot make in the leaf, write the one-line reason to reharness/.cache/evolve/needs-redesign.md and stop.`);
        },
        on: "verify",
      },

      verify: {
        entry: async (c) => {
          if (existsSync(escalatePath) && readFileSync(escalatePath, "utf-8").trim()) {
            c.emit("↑ heal escalated to replan: the fix needs a topology/contract change");
            return "REPLAN";
          }
          const errs = verifyGenerated(target);
          if (!errs.length) { c.emit("✓ heal verified"); return "PASS"; }
          c.retry("heal");
          c.emit(`✗ heal: ${errs.length} verify error(s)`);
          return "FAIL";
        },
        on: {
          PASS: "confirm_rerun",
          REPLAN: "replan",
          FAIL: [
            { target: "heal", guard: (c) => c.retries("heal") < CORRECTION_RETRIES },
            { target: "error" },
          ],
        },
      },

      // Auto-redesign: the fix is in the spec, not a leaf. The replan agent edits the skeleton; the compiler
      // re-constructs (preserving existing fills, stubbing only new states) → fills the new stubs → re-verifies
      // → re-runs to confirm. Same double gate (verify + re-run) as the leaf path. Bounded.
      replan: {
        entry: async (c) => {
          emitCompiledFromSkeletonsDir(reharnessDir, c.data.skeletonId as string | undefined); // scoped to the command being healed
          const id = c.data.skeletonId as string, stage = c.data.failedStage as string;
          const reason = c.data.reason as string, runDir = c.data.failRunDir as string;
          await c.agent("replan",
            `A run FAILED at '${stage}'${reason ? `: ${reason}` : ""}, and heal determined the fix needs a topology/contract change.\n` +
            `Read reharness/.cache/evolve/needs-redesign.md (the needed change) and reharness/.cache/scratch/_compiled.md (the whole pipeline).\n` +
            `Repair ONLY reharness/skeletons/${id}.xml (graph + contracts; data flow is derived). The failed run dir is ${runDir}.`,
            { append: "_fsm-syntax", validate: skeletonErrors });
          rmSync(escalatePath, { force: true }); // request consumed
        },
        on: "construct",
      },

      construct: {
        entry: async (c) => {
          try { generateAllFromSkeletons(reharnessDir); c.emit("✓ re-constructed from the repaired skeleton"); return "DONE"; }
          catch (e: any) { c.emit(`✗ construct: ${e.message}`); return "ERROR"; }
        },
        on: { DONE: "fill_changed", ERROR: "error" },
      },

      fill_changed: {
        entry: async (c) => {
          const id = c.data.skeletonId as string;
          await Promise.all([
            c.agent("fill_prompts_md", `Fill any NEW agent prompt stubs (<!-- TODO) in reharness/agents/${id}/<name>/SYSTEM.md from the skeleton contracts (this command's agents live under reharness/agents/${id}/). Edit only SYSTEM.md files; leave already-filled prompts unchanged.`),
            c.agent("fill_prompts_lib", `Fill any NEW code-state stubs (// TODO) in reharness/lib/${id}-states.ts from the skeleton contracts. Edit only the lib .ts file; leave already-filled functions unchanged.`),
          ]);
        },
        on: "verify_replan",
      },

      verify_replan: {
        entry: async (c) => {
          const errs = verifyGenerated(target);
          if (!errs.length) { c.emit("✓ replan verified"); return "PASS"; }
          c.retry("replan");
          c.emit(`✗ replan: ${errs.length} verify error(s)`);
          return "FAIL";
        },
        on: {
          PASS: "confirm_rerun",
          FAIL: [
            { target: "replan", guard: (c) => c.retries("replan") < CORRECTION_RETRIES },
            { target: "error" },
          ],
        },
      },

      // Re-run the same command (persisted argv) to confirm the heal actually fixes the failure end-to-end.
      // Best-effort: if argv/command isn't recoverable, the static re-verify already passed → accept.
      confirm_rerun: {
        entry: async (c) => {
          const argv = c.data.argv as string[] | undefined, id = c.data.skeletonId as string;
          if (!argv || !id) { c.emit("→ heal verified (no argv to re-run — static confirm only)"); return "DONE"; }
          const project = await loadProject(target);
          const def = project?.commands?.[id];
          if (!project || !def) { c.emit("→ heal verified (command not loadable — static confirm only)"); return "DONE"; }
          c.emit(`↻ re-running '${id}' with the original args to confirm the heal…`);
          const pipeline = def.run(argv, { root: project.root, agents: project.agents, cwd: project.root });
          if (!pipeline) { c.emit("→ re-run produced no pipeline — static confirm only"); return "DONE"; }
          const status = await pipeline.run(c.emit, { provider: runOpts.provider, piModel: runOpts.piModel }); // re-run on the SAME backend the user selected (not the default)
          if (status === "success") { c.emit("✓ re-run succeeded — heal confirmed end-to-end"); return "DONE"; }
          c.emit("✗ re-run still fails — another heal round");
          c.retry("heal");
          return "RETRY";
        },
        on: {
          DONE: "fixed",
          RETRY: [
            { target: "heal", guard: (c) => c.retries("heal") < CORRECTION_RETRIES },
            { target: "error" },
          ],
        },
      },

      noop: { type: "final", status: "success" },
      stable: { type: "final", status: "success" },
      improved: { type: "final", status: "success" },
      fixed: { type: "final", status: "success", entry: async (c) => { c.emit("✓ evolve: pipeline healed (re-verified" + (c.data.argv ? " + re-run confirmed" : "") + ")"); } },
      error: { type: "final", status: "error" },
    },
  });
}

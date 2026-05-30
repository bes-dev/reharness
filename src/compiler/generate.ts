import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { definePipeline } from "../runtime/fsm.js";
import type { Pipeline } from "../runtime/types.js";
import type { Skeleton } from "./schema.js";
import { parseSkeletonXML, serializeSkeletonXML } from "./xml.js";
import { RESERVED_IDS } from "./schema.js";
import { validateSkeleton, validateContracts, analyzeDataFlow, configFlowErrors, extractCodeDataIO, applyCodeDataIO } from "./analysis/index.js";
import { generateAllFromSkeletons, emitCompiledFromSkeletonsDir } from "./codegen.js";
import { verifyGenerated } from "./verify.js";

const BUILTIN_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "agents");

const PRD = ".reharness/generate/prd.md";
const DRAFT = ".reharness/generate/draft-skeleton.xml";
const RESEARCH = ".reharness/generate/research-findings.md";
const ESCALATE = ".reharness/generate/escalate.md";

/** Cheap model for rendering-only / surgical-patch steps. Override via env var if Haiku is unavailable. */
const LIGHT_MODEL = process.env.REHARNESS_LIGHT_MODEL || "anthropic/claude-haiku-4-5";

export interface GenerateOptions {
  cwd: string;
  input: string;
  fast?: boolean;
  autoApprove?: boolean;
}

/**
 * Self-hosted FSM that compiles a workflow from a natural-language description.
 *
 * Flow: research → PRD (human-readable spec) → APPROVAL → design (graph + contracts) → construct → fill → polish → verify.
 * The human approves the PRD ONLY — confirmation the compiler understood the intent. Everything downstream
 * (graph, contracts, code) is generated from the approved PRD; the human never reviews the FSM graph.
 * Inter-stage data flow is DERIVED from the topology (per-stage workspace), never authored — so it can't drift.
 *
 * Validation philosophy:
 *  - DETERMINISTIC checks (skeleton validity, contract coverage) run IN-SESSION: the producing agent
 *    (design/redesign) runs under RPC and re-prompts itself with the errors until clean. Static analysis has
 *    no bias, so fixing in-context is correct — near-free.
 *  - SEMANTIC correction is ONE lightweight `polish` agent: in a single hot context it reviews the pipeline
 *    against the PRD and fixes what it judges worth fixing, editing ONLY leaf artifacts (prompts + code).
 *    Bounded by prompt + hard timeout; topology problems escalate to the rare `redesign`. Then deterministic
 *    `verify` (tsc) is the objective backstop. No review→fix→re-review loop re-running the compiler per fix.
 */
export function buildGeneratePipeline(opts: GenerateOptions): Pipeline {
  const target = opts.cwd;
  const reharnessDir = resolve(target, ".reharness");
  const genDir = resolve(reharnessDir, "generate");
  const draftPath = resolve(target, DRAFT);
  const escalatePath = resolve(target, ESCALATE);
  const verifyErrorsPath = resolve(genDir, "verify-errors.md");
  const dataflowErrorsPath = resolve(genDir, "dataflow-errors.md");
  const fast = !!opts.fast;
  const autoApprove = !!opts.autoApprove;

  const parseDraft = (): { sk?: Skeleton; errors: string[] } => {
    if (!existsSync(draftPath)) return { errors: ["draft-skeleton.xml is missing"] };
    try {
      const sk = parseSkeletonXML(readFileSync(draftPath, "utf-8"));
      return { sk, errors: validateSkeleton(sk) };
    } catch (err: any) {
      return { errors: [`XML parse error: ${err.message}`] };
    }
  };

  // Deterministic validator run in-session (passed to c.agent as `validate`). validateSkeleton covers
  // identifiers/reachability/dead-ends/reserved-id; contractErrors adds per-node contract coverage.
  const contractErrors = (): string[] => {
    const { sk, errors } = parseDraft();
    return [...errors, ...(sk ? [...validateContracts(sk), ...configFlowErrors(sk)] : [])];
  };

  return definePipeline({
    config: { target, input: opts.input, fast, autoApprove },
    initial: "maybe_research",
    cwd: target,
    agents: BUILTIN_AGENTS_DIR,
    logsDir: resolve(reharnessDir, "logs"),

    states: {
      maybe_research: {
        type: "switch",
        branches: [
          { target: "prd", guard: (c) => !!c.config.fast },
          { target: "research" },
        ],
      },

      research: {
        entry: async (c) => {
          mkdirSync(genDir, { recursive: true });
          await c.agent("research",
            `Research the domain for this task:\n\n${c.config.input}\n\n` +
            `Write findings to ${RESEARCH} following the contract in your prompt. Stop after ~5 minutes.`);
        },
        on: "prd",
      },

      // ── Distil a human-readable PRD from every available artifact (request + research). This is the ONE
      //    thing the human approves — confirmation the compiler understood the intent. Everything downstream
      //    is generated from the PRD, not the raw request. ──
      prd: {
        entry: async (c) => {
          mkdirSync(genDir, { recursive: true });
          const researchNote = existsSync(resolve(target, RESEARCH))
            ? `Ground it in the research findings at ${RESEARCH}.`
            : `No research-findings.md — rely on the request and training knowledge.`;
          await c.agent("prd",
            `Write a PRD (human-readable spec) for the workflow the user wants, to ${PRD}. ${researchNote}\n\n` +
            `User request:\n\n${c.config.input}`);
        },
        on: "maybe_approve_prd",
      },

      maybe_approve_prd: {
        type: "switch",
        branches: [
          { target: "design", guard: (c) => !!c.config.autoApprove },
          { target: "review_prd" },
        ],
      },

      review_prd: {
        type: "approval",
        prompt: "Review the PRD — does it capture what you want built? Approve to let the compiler design and build it, or revise to refine the PRD interactively.",
        artifacts: [PRD],
        autoEvent: "APPROVED",
        on: { APPROVED: "design", REVISED: "discuss_prd" },
      },

      discuss_prd: {
        entry: async (c) => {
          await c.interactive("discuss_prd",
            `The user wants to refine the PRD. Discuss their concerns and update ${PRD} to match what they actually want — ` +
            `it is a human-readable spec, NOT an FSM/graph. Edit ONLY ${PRD}. Original request:\n\n${c.config.input}`,
            { artifacts: [PRD] });
        },
        on: "review_prd",
      },

      // ── Design: one pass — topology + behavioural contracts. Self-validates in-session (graph validity +
      //    contract coverage). Data flow between stages is NOT authored here: the compiler derives it from
      //    the graph (per-stage workspace), so there is nothing to wire or keep in sync. ──
      design: {
        entry: async (c) => {
          await c.agent("design",
            `Design the FSM that implements the approved PRD at ${PRD}: choose the stages, wire them into a valid graph, ` +
            `and give every agent/code/interactive state a behavioural <contract> (CDATA) describing what it does. ` +
            `Write the whole skeleton to ${DRAFT}. Do NOT declare data flow — the compiler derives it from the graph.`,
            { append: "_fsm-syntax", validate: contractErrors });
        },
        on: "construct",
      },

      // Deterministic codegen. Skeleton is already validated in-session by structure/contracts/redesign,
      // so this rarely fails; a failure here is a genuine codegen bug → terminal.
      construct: {
        entry: async (c) => {
          const { sk, errors } = parseDraft();
          if (!sk || errors.length || RESERVED_IDS.has(sk.id)) {
            c.emit(`✗ construct: ${!sk ? errors.join("; ") : RESERVED_IDS.has(sk.id) ? `id '${sk.id}' reserved` : errors.join("; ")}`);
            return "ERROR";
          }
          try {
            const skeletonsDir = resolve(reharnessDir, "skeletons");
            mkdirSync(skeletonsDir, { recursive: true });
            copyFileSync(draftPath, resolve(skeletonsDir, `${sk.id}.xml`));
            generateAllFromSkeletons(reharnessDir);
            c.emit(`✓ skeleton ${sk.id} compiled`);
            return "DONE";
          } catch (err: any) {
            c.emit(`✗ construct: ${err.message}`);
            return "ERROR";
          }
        },
        on: { DONE: "fill_prompts", ERROR: "error" },
      },

      // Initial full fill (everything is a stub). md + lib in parallel. Fixes later are issue-scoped, not here.
      fill_prompts: {
        entry: async (c) => {
          await Promise.all([
            c.agent("fill_prompts_md", `Fill the agent prompt stubs (<!-- TODO) in .reharness/agents/*.md from each agent state's <contract> in the skeleton. Edit only .md files.`),
            c.agent("fill_prompts_lib", `Fill the code state stubs (// TODO) in .reharness/lib/<id>-states.ts from each code state's <contract>. Read upstream stage outputs via c.dir('<stage>'). Edit only the lib .ts file.`),
          ]);
        },
        on: "check_dataflow",
      },

      // Deterministic data-flow prep (not a gate): extract code states' ctx.data I/O from the filled lib,
      // persist the annotated skeleton, and write the use-before-def report for polish to consume. Always → polish.
      check_dataflow: {
        entry: async (c) => {
          const { sk } = parseDraft();
          if (!sk) { c.emit("⚠ data-flow: skeleton unparseable — deferring"); return; }
          const libPath = resolve(reharnessDir, "lib", `${sk.id}-states.ts`);
          const libSource = existsSync(libPath) ? readFileSync(libPath, "utf-8") : undefined;
          if (libSource) applyCodeDataIO(sk, extractCodeDataIO(libSource));
          const skPath = resolve(reharnessDir, "skeletons", `${sk.id}.xml`);
          if (existsSync(skPath)) writeFileSync(skPath, serializeSkeletonXML(sk)); // persist annotated for polish
          const errs = [...analyzeDataFlow(sk), ...configFlowErrors(sk, libSource)];
          writeFileSync(dataflowErrorsPath, errs.join("\n"));
          c.emit(errs.length ? `⚠ data-flow: ${errs.length} issue(s) — polish will address` : "✓ data-flow ok");
        },
        on: "polish",
      },

      // Skeleton-level escalation — self-validates in-session (structural + coverage).
      // Rare last-resort: polish hit a problem it could not fix in the leaves and asked for a topology change.
      redesign: {
        entry: async (c) => {
          const reason = existsSync(escalatePath) ? readFileSync(escalatePath, "utf-8").trim() : "";
          const dfNote = existsSync(dataflowErrorsPath) && readFileSync(dataflowErrorsPath, "utf-8").trim()
            ? ` Data-flow issues are in .reharness/generate/dataflow-errors.md (a node reads ctx.data not written on every path — insert an initialiser node on the path that lacks the writer).` : "";
          await c.agent("redesign",
            `Polish requested a skeleton-level change it could not make in the leaves:\n${reason}\n\n` +
            `Read .reharness/generate/_compiled.md.${dfNote} Stay faithful to the approved PRD at ${PRD} — fix HOW it's ` +
            `realized, never WHAT it means. Edit ONLY ${DRAFT} (graph + contracts live there; data flow is derived from the graph). ` +
            `After your edit: construct → fill_prompts → check_dataflow → polish re-run.`,
            { append: "_fsm-syntax", validate: contractErrors });
          if (existsSync(escalatePath)) writeFileSync(escalatePath, "");
        },
        on: "construct",
      },

      // ── Polish: ONE agent reviews the whole pipeline against the PRD and fixes what it judges worth fixing,
      //    editing ONLY leaf artifacts (agent prompts + code). Responsibility is bounded by the prompt
      //    (critical/major only, one pass, no skeleton edits) and a hard timeout. A topology problem it can't
      //    fix in the leaves → it writes escalate.md and the FSM routes to the rare redesign. The review→fix→
      //    re-review loop collapses into this single hot-context pass — no re-running the compiler per fix. ──
      polish: {
        entry: async (c) => {
          emitCompiledFromSkeletonsDir(reharnessDir);
          if (existsSync(escalatePath)) writeFileSync(escalatePath, "");
          const dfNote = existsSync(dataflowErrorsPath) && readFileSync(dataflowErrorsPath, "utf-8").trim()
            ? ` Also resolve the data-flow issues listed in .reharness/generate/dataflow-errors.md.` : "";
          await c.agent("polish",
            `Review the generated pipeline (.reharness/generate/_compiled.md) against the approved PRD at ${PRD}, ` +
            `then fix what genuinely needs fixing — editing ONLY agent prompts (.reharness/agents/*.md) and code ` +
            `(.reharness/lib/<id>-states.ts).${dfNote} If a fix requires a topology change you cannot make in the ` +
            `leaves, write the one-line reason to ${ESCALATE} and stop (do not edit the skeleton).`,
            { append: "_fsm-syntax" });
          if (existsSync(escalatePath) && readFileSync(escalatePath, "utf-8").trim()) {
            c.emit("↻ polish: topology change needed → redesign");
            c.retry("polish");
            return "ESCALATE";
          }
          c.emit("✓ polish done");
          return "DONE";
        },
        timeoutMs: 720_000,
        on: {
          DONE: "verify",
          TIMEOUT: "verify", // hard backstop: proceed to the deterministic gate, partial fixes and all
          ESCALATE: [
            { target: "redesign", guard: (c) => c.retries("polish") < 2 },
            { target: "error" },
          ],
        },
      },

      verify: {
        entry: async (c) => {
          const errs = verifyGenerated(target);
          if (errs.length === 0) {
            if (existsSync(verifyErrorsPath)) writeFileSync(verifyErrorsPath, "");
            c.emit("✓ verify passed");
            return "PASS";
          }
          mkdirSync(genDir, { recursive: true });
          writeFileSync(verifyErrorsPath, errs.join("\n\n"));
          c.retry("verify");
          c.emit(`✗ verify: ${errs.length} error(s)`);
          return "FAIL";
        },
        on: {
          PASS: "done",
          FAIL: [
            { target: "fix_verify", guard: (c) => c.retries("verify") < 2 },
            { target: "error" },
          ],
        },
      },

      // Scoped fix for verify (TypeScript) errors — they live in the lib file.
      fix_verify: {
        entry: async (c) => {
          const { sk } = parseDraft();
          const id = sk?.id ?? "";
          await c.agent("patch_node",
            `The generated pipeline fails verification (TypeScript / FSM load). Read .reharness/generate/verify-errors.md and ` +
            `fix the errors in .reharness/lib/${id}-states.ts. Edit ONLY that file; minimal edits.`,
            { model: LIGHT_MODEL });
        },
        on: "verify",
      },

      done: { type: "final", status: "success", entry: async (c) => { c.emit(`✓ pipeline ready in ${reharnessDir}`); } },
      error: { type: "final", status: "error" },
    },
  });
}

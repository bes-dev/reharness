import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { definePipeline } from "../runtime/fsm.js";
import type { Pipeline, StateContext } from "../runtime/types.js";
import type { Skeleton } from "./schema.js";
import { parseSkeletonXML, serializeSkeletonXML } from "./xml.js";
import { validateSkeleton, validateContracts, analyzeDataFlow, configFlowErrors, extractCodeDataIO, applyCodeDataIO } from "./analysis/index.js";
import { generateAllFromSkeletons, emitCompiledFromSkeletonsDir } from "./codegen.js";
import { loadSkeletons, loadSkeletonIds } from "./project-fs.js";
import { layout } from "../layout.js";
import { deriveManifest } from "./manifest.js";
import { verifyGenerated } from "./verify.js";
import { SESSION_CHUNK_CHARS, LIGHT_MODEL, COMPILER_CONCURRENCY, CORRECTION_RETRIES } from "../config.js";

const BUILTIN_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "agents");

const PRD = "reharness/.cache/scratch/prd.md";
const PRD_PREV = "reharness/.cache/scratch/prd-prev.md";
const PRDS = "reharness/prds"; // per-command PRD archive: prds/<cmdId>.md (the persistent intent ≈ a crate's manifest)
const DRAFT = "reharness/.cache/scratch/draft-skeleton.xml";
const SKILLS = "reharness/skills";
const ESCALATE = "reharness/.cache/scratch/escalate.md";
const SESSION = "reharness/.cache/scratch/session.md";              // raw session (any format) the runner stages for the distill front
const SESSION_DIGEST = "reharness/.cache/scratch/session-digest.md"; // condensed trajectory digest (large sessions)

/** Split text into ≤max-char pieces on line boundaries (a giant single line is hard-split). */
function chunkByLines(text: string, max: number): string[] {
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf.length + line.length + 1 > max && buf) { out.push(buf); buf = ""; }
    if (line.length + 1 > max) { for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max)); continue; }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) out.push(buf);
  return out;
}


export interface GenerateOptions {
  cwd: string;
  input: string;
  fast?: boolean;
  autoApprove?: boolean;
  /** Amend mode (`amend`): start from the existing pipeline, fold `input` into the PRD, and apply a minimal
   *  skeleton delta (review_prd → amend_design) instead of a from-scratch design. */
  amend?: boolean;
  /** User-chosen command name (`--name`, compile only) — a valid skeleton id. Overrides the design's auto-id. */
  name?: string;
  /** Amend target: which command to amend (multi-command). Empty ⇒ the sole command. */
  command?: string;
  /** Session front (`compile --from-session`): the runner has staged the raw session at the scratch `session.md`;
   *  the pipeline distils it into a PRD instead of authoring one from a description. */
  session?: boolean;
  /** Harness front (`compile --from-harness <dir>`): absolute path to an existing harness/implementation directory
   *  the `research` agent explores in place as a grounding source. Empty string ⇒ no harness. */
  harness?: string;
}

// The runtime tells EVERY agent to "write all outputs to your output dir", but the PRD and skills are DURABLE
// project-level artifacts at canonical paths OUTSIDE it. These recover them from the agent's out dir if they
// landed there instead — idempotent (a no-op when the agent already hit the canonical path), so they only ADD a
// safety net. ONE mechanism for every producer (prd, amend_prd, distill | research).
const prdPresent = (target: string) => { const d = resolve(target, PRD); return existsSync(d) && !!readFileSync(d, "utf-8").trim(); };

/** Ensure the canonical PRD exists, recovering it from the agent's output dir if needed. Returns whether it does. */
export function recoverPrd(target: string, c: StateContext): boolean {
  if (!prdPresent(target)) {
    const src = resolve(c.out(), "prd.md");
    if (existsSync(src)) { const durable = resolve(target, PRD); mkdirSync(dirname(durable), { recursive: true }); copyFileSync(src, durable); }
  }
  return prdPresent(target);
}

/** Recover any skill docs the agent wrote into its output dir to the canonical reharness/skills/ (best-effort). */
export function recoverSkills(target: string, c: StateContext): void {
  const out = c.out(), skillsDir = resolve(target, SKILLS);
  // An agent may drop a skill at the TOP of its out dir ("write to your output dir") OR at the prompt's literal
  // project path `reharness/skills/<topic>.md` (a nested subdir inside out). Recover from BOTH so a skill is
  // never stranded — without this, a research run that follows the path literally writes skills enhance can't see.
  for (const src of [out, resolve(out, SKILLS)])
    for (const f of (existsSync(src) ? readdirSync(src) : []))
      if (f.endsWith(".md")) { mkdirSync(skillsDir, { recursive: true }); copyFileSync(resolve(src, f), resolve(skillsDir, f)); }
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
  const L = layout(target);
  const reharnessDir = L.root; // bundle root (alias — the deliverable subpath helpers below read naturally)
  const genDir = L.scratch; // transient compiler scratch (PRD/draft/errors); the bundle's run-exhaust cache
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
    config: { target, input: opts.input, fast, autoApprove, amend: !!opts.amend, name: opts.name ?? "", command: opts.command ?? "", session: !!opts.session, harness: opts.harness ?? "" },
    initial: "start",
    cwd: target,
    agents: BUILTIN_AGENTS_DIR,
    logsDir: L.runs,

    states: {
      // Three fronts converge on the PRD (the unification point): compile (research → prd), amend
      // (load_amend → amend_prd), and session (load_session → [condense] → distill — compile from a recorded
      // demonstration). Everything from review_prd onward is shared.
      start: {
        type: "switch",
        branches: [
          { target: "load_session", guard: (c) => !!c.config.session },
          { target: "load_amend", guard: (c) => !!c.config.amend },
          { target: "maybe_research" },
        ],
      },

      // ── session front: distil a recorded agent/chat session (a DEMONSTRATION) into a PRD. The session is read
      //    RAW (any format — JSONL/JSON/markdown/transcript); the LLM is the universal parser. A large session is
      //    condensed (map-reduce over chunks) first so distill always reads something that fits. ──
      load_session: {
        entry: async (c) => {
          const sessionPath = resolve(target, SESSION);
          if (!existsSync(sessionPath)) { c.emit(`✗ session: no staged session at ${SESSION}`); return "ERROR"; }
          const text = readFileSync(sessionPath, "utf-8");
          if (!text.trim()) { c.emit("✗ session: the session is empty"); return "ERROR"; }
          if (text.length <= SESSION_CHUNK_CHARS) { c.data.sessionDoc = SESSION; c.emit(`✓ session: ${text.length} chars → ground + distil`); return "GROUND"; }
          const chunks = chunkByLines(text, SESSION_CHUNK_CHARS);
          const dir = resolve(genDir, "session-chunks"); mkdirSync(dir, { recursive: true });
          chunks.forEach((ch, i) => writeFileSync(resolve(dir, `chunk-${i}.md`), ch));
          c.data.chunks = chunks.map((_, i) => i);
          c.emit(`✓ session: large (${text.length} chars) → condensing ${chunks.length} chunk(s)`);
          return "CONDENSE";
        },
        on: { GROUND: "maybe_research", CONDENSE: "condense", ERROR: "error" },
      },

      // Map: one digest per chunk, in parallel (isolated context per chunk). Reduce: merge_digest concatenates.
      condense: { type: "parallel", over: (c) => c.data.chunks, branch: "condense_chunk", join: "merge_digest", concurrency: COMPILER_CONCURRENCY },

      condense_chunk: {
        entry: async (c) => {
          const i = c.branchInput as number;
          // Read the (durable) chunk; write digest.md to the branch's OWN output dir — the runtime owns that path
          // and injects it, so the agent never picks between a hand-built path and its workspace dir (no split).
          await c.agent("condense",
            `Read the session slice at reharness/.cache/scratch/session-chunks/chunk-${i}.md and write a TRAJECTORY DIGEST ` +
            `named digest.md to YOUR OUTPUT DIRECTORY (the absolute path given in your task): the meaningful actions/` +
            `decisions/parameters in this slice of a recorded agent session, dropping noise (dead-ends, backtracking, ` +
            `chatter). Keep enough that the slices together reconstruct the repeatable task.`);
        },
        on: {},
      },

      merge_digest: {
        entry: async (c) => {
          const dirs = c.dirs("condense_chunk"); // one dir per chunk (branch), in order — the map's outputs
          const parts = dirs.map(d => { const p = resolve(d, "digest.md"); return existsSync(p) ? readFileSync(p, "utf-8") : ""; });
          const kept = parts.filter(Boolean);
          writeFileSync(resolve(target, SESSION_DIGEST), kept.join("\n\n---\n\n"));
          c.data.sessionDoc = SESSION_DIGEST;
          c.emit(`✓ session: merged ${kept.length}/${dirs.length} chunk digest(s)`);
          return "DONE";
        },
        on: { DONE: "maybe_research" },
      },

      distill: {
        entry: async (c) => {
          mkdirSync(genDir, { recursive: true });
          const doc = (c.data.sessionDoc as string) || SESSION;
          const siblings = loadSkeletonIds(L.skeletons);
          const siblingsNote = siblings.length
            ? ` This workspace already has command(s): ${siblings.join(", ")}. If the demonstrated task relates to one, say so in the PRD so the intent stays consistent.`
            : "";
          const hint = c.config.input ? `\n\nThe user added this hint about what to generalise:\n${c.config.input}` : "";
          const skillsNote = existsSync(resolve(target, SKILLS))
            ? ` Ground the intent in the domain-skills at ${SKILLS}/ (research already grounded the demonstration's integration facts there).`
            : "";
          await c.agent("distill",
            `A recorded agent/chat session (a DEMONSTRATION of a task done once) is at ${doc}. Read it and distil the ` +
            `REPEATABLE, parameterised workflow it demonstrates into a PRD at ${PRD} — generalise from this one example: ` +
            `identify the recurring task, its parameters (what would change next time — a repo, a path, a query), the ` +
            `essential steps (dropping the human's dead-ends/exploration), and the acceptance criteria.${skillsNote}${siblingsNote}${hint}`);
          if (!recoverPrd(target, c)) { c.emit("✗ session: distill produced no PRD"); return "ERROR"; }
          return "DONE";
        },
        on: { DONE: "maybe_approve_prd", ERROR: "error" },
      },

      // ── amend front: seed from the existing pipeline, then fold the request into the PRD. ──
      load_amend: {
        entry: async (c) => {
          const skeletonsDir = L.skeletons;
          const skels = loadSkeletons(skeletonsDir);
          const want = c.config.command as string;
          const sk = want ? skels.find(s => s.id === want) : (skels.length === 1 ? skels[0] : undefined);
          if (!sk) {
            const list = skels.map(s => s.id).join(", ");
            c.emit(skels.length === 0
              ? "✗ amend: nothing to amend here (no compiled command). Run `reharness compile` first."
              : want ? `✗ amend: no command '${want}' here. Available: ${list}.`
                     : `✗ amend: several commands here — name one: \`reharness amend <command> <request>\`. Available: ${list}.`);
            return "ERROR";
          }
          mkdirSync(genDir, { recursive: true });
          // Restore THIS command's persistent PRD as the working prd.md (so amend edits the right intent).
          const archive = resolve(target, PRDS, `${sk.id}.md`);
          if (existsSync(archive)) copyFileSync(archive, resolve(target, PRD));
          if (!existsSync(resolve(target, PRD))) {
            c.emit(`✗ amend: no PRD on record for '${sk.id}' — re-compile it first.`);
            return "ERROR";
          }
          copyFileSync(resolve(target, PRD), resolve(target, PRD_PREV));     // stash the pre-amend PRD (rollback + diff)
          copyFileSync(resolve(skeletonsDir, `${sk.id}.xml`), draftPath);    // seed DRAFT with the target skeleton
          c.emit(`✓ amend: loaded '${sk.id}' for amendment`);
          return "DONE";
        },
        on: { DONE: "amend_prd", ERROR: "error" },
      },

      amend_prd: {
        entry: async (c) => {
          await c.agent("amend_prd",
            `The user wants to IMPROVE an existing pipeline. Amend the PRD at ${PRD} to incorporate this request — ` +
            `preserve everything still valid, change only what the request implies, and put a short "## Amendment" note ` +
            `at the top summarising what changed. The pre-amendment PRD is at ${PRD_PREV} for reference.\n\n` +
            `Request:\n\n${c.config.input}`);
          if (!recoverPrd(target, c)) { c.emit("✗ amend: no PRD produced"); return "ERROR"; }
          return "DONE";
        },
        on: { DONE: "maybe_approve_prd", ERROR: "error" },
      },

      // Both grounding fronts (request + session) converge here: --fast skips grounding, else run the one
      // evidence-adaptive `research` agent, then route the grounded result to the right PRD producer.
      maybe_research: {
        type: "switch",
        branches: [
          { target: "maybe_distill", guard: (c) => !!c.config.fast },
          { target: "research" },
        ],
      },

      // One research agent grounds the domain into skills/ from WHATEVER evidence is present — the request, a
      // recorded session/trace (observed ground truth), a harness/implementation (written contracts), and the web
      // for gaps. Same agent for every front, so a trace and a harness can corroborate each other; the source
      // priority and conflict reconciliation live in its prompt.
      research: {
        entry: async (c) => {
          mkdirSync(resolve(target, SKILLS), { recursive: true });
          const trace = c.data.sessionDoc as string | undefined; // set by load_session/merge_digest on the session front
          // Evidence to ground from — the request, a recorded session, and/or an existing harness directory the
          // agent EXPLORES IN PLACE with its file tools (not flattened): it reads the orchestration spec, follows
          // subagent/tool references to the per-step agent definitions, and reads their skills — so the grounding
          // preserves the harness's real structure (which agent → which role, which skill → which step).
          const harness = c.config.harness as string;
          const evidence = [
            c.config.input ? `the user's REQUEST/task: ${c.config.input}` : "",
            trace ? `a RECORDED SESSION (a demonstration — observed ground truth) at ${trace}` : "",
            harness ? `an existing HARNESS/implementation to STUDY at the directory ${harness} — explore it with your file tools (ls/read/grep): read the top-level orchestration spec, FOLLOW its subagent/tool references to the per-step agent definitions, and read each agent's skills. For each capability-bearing skill an agent carries, write its operative core (distilled) as its own reharness/skills/<topic>.md and note which step/leaf carries it — PRESERVE the skill content, don't just name it (enhance attaches only skills that exist in skills/)` : "",
          ].filter(Boolean).map((e) => `- ${e}`).join("\n");
          await c.agent("research",
            `Ground the domain(s) into one domain-skill per external integration/tool at ${SKILLS}/<topic>.md.\n\n` +
            `Evidence available:\n${evidence}\n\n` +
            `Use every source present (priority: observed trace > written harness > web for gaps > never memory for a ` +
            `load-bearing fact) and reconcile conflicts. Follow your prompt's contract — get the Integration/I/O section ` +
            `exact (fill writes code from it).`);
          recoverSkills(target, c);
        },
        on: "maybe_distill",
      },

      // Route the grounded result to the right PRD producer: distil a trace (session front) or draft from the
      // request (request front). Reached from research, or directly from maybe_research on --fast (no grounding).
      maybe_distill: {
        type: "switch",
        branches: [
          { target: "distill", guard: (c) => !!c.config.session },
          { target: "prd" },
        ],
      },

      // ── Distil a human-readable PRD from every available artifact (request + research). This is the ONE
      //    thing the human approves — confirmation the compiler understood the intent. Everything downstream
      //    is generated from the PRD, not the raw request. ──
      prd: {
        entry: async (c) => {
          mkdirSync(genDir, { recursive: true });
          const researchNote = existsSync(resolve(target, SKILLS))
            ? `Ground the intent in the domain-skills at ${SKILLS}/ (read them for what the domain entails).`
            : `No ${SKILLS}/ — rely on the request and training knowledge.`;
          const siblings = loadSkeletonIds(L.skeletons);
          const siblingsNote = siblings.length
            ? ` This workspace already has command(s): ${siblings.join(", ")}. If the request relates to one (works on the same artifact, or shares an input like a name/slug), say so in the PRD so the intent stays consistent with it.`
            : "";
          await c.agent("prd",
            `Write a PRD (human-readable spec) for the workflow the user wants, to ${PRD}. ${researchNote}${siblingsNote}\n\n` +
            `User request:\n\n${c.config.input}`);
          if (!recoverPrd(target, c)) { c.emit("✗ no PRD produced"); return "ERROR"; }
          return "DONE";
        },
        on: { DONE: "maybe_approve_prd", ERROR: "error" },
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
        on: {
          APPROVED: [
            { target: "amend_design", guard: (c) => !!c.config.amend }, // amend: delta-edit the seeded skeleton
            { target: "design" },                                       // compile: design from scratch
          ],
          REVISED: "discuss_prd",
        },
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

      // ── Amend-design: a MINIMAL delta on the seeded skeleton, faithful to the amended PRD.
      //    Reuses the whole tail (construct preserves filled leaves + appends only new stubs; fill fills only
      //    those; polish reconciles any existing leaf whose contract the amendment changed). ──
      amend_design: {
        entry: async (c) => {
          emitCompiledFromSkeletonsDir(reharnessDir, parseDraft().sk?.id); // scoped to the command being amended
          await c.agent("amend_design",
            `The PRD at ${PRD} was amended (see its "## Amendment" note). ${DRAFT} is seeded with the CURRENT ` +
            `skeleton; reharness/.cache/scratch/_compiled.md shows the existing prompts + code. Apply a MINIMAL delta to ` +
            `${DRAFT} that implements the amended PRD — reuse existing states, add only what the new requirement needs, ` +
            `stay faithful to intent (change HOW, never WHAT). Edit ONLY ${DRAFT}; data flow is derived from the graph. ` +
            `After your edit: construct → fill_prompts → check_dataflow → polish re-run.`,
            { append: "_fsm-syntax", validate: contractErrors });
        },
        on: "construct",
      },

      // ── Design: one pass — topology + behavioural contracts. Self-validates in-session (graph validity +
      //    contract coverage). Data flow between stages is NOT authored here: the compiler derives it from
      //    the graph (per-stage workspace), so there is nothing to wire or keep in sync. ──
      design: {
        entry: async (c) => {
          const siblings = loadSkeletonIds(L.skeletons);
          const siblingsNote = siblings.length
            ? ` This workspace already has command(s): ${siblings.join(", ")}. If yours coordinates with one (same artifact / shared input), READ its skeleton (reharness/skeletons/<id>.xml — topology + contracts) and lib (reharness/lib/<id>-states.ts — exact paths it uses) and design yours to match: reuse the same artifact path convention and the same shared input. Reuse fitting reharness/skills/.`
            : "";
          await c.agent("design",
            `Design the FSM that implements the approved PRD at ${PRD}: choose the stages, wire them into a valid graph, ` +
            `and give every agent/code/interactive state a behavioural <contract> (CDATA) describing what it does. ` +
            `Write the whole skeleton to ${DRAFT}. Do NOT declare data flow — the compiler derives it from the graph.${siblingsNote}`,
            { append: "_fsm-syntax", validate: contractErrors });
        },
        on: "construct",
      },

      // Deterministic codegen. Skeleton is already validated in-session by structure/contracts/redesign,
      // so this rarely fails; a failure here is a genuine codegen bug → terminal.
      construct: {
        entry: async (c) => {
          // --name (compile only): force the skeleton id so the command is named as the user asked — surgically,
          // in the draft itself, so every downstream stage that re-parses it (check_dataflow, fix_verify) agrees.
          if (c.config.name && !c.config.amend && existsSync(draftPath)) {
            const raw = readFileSync(draftPath, "utf-8");
            const renamed = raw.replace(/(<skeleton\b[^>]*\bid=")[^"]*(")/, `$1${c.config.name}$2`);
            if (renamed !== raw) writeFileSync(draftPath, renamed);
          }
          const { sk, errors } = parseDraft();
          // validateSkeleton (in parseDraft) already lints the reserved-id rule, so `errors` covers it.
          if (!sk || errors.length) {
            c.emit(`✗ construct: ${!sk ? "draft-skeleton.xml unparseable" : errors.join("; ")}`);
            return "ERROR";
          }
          try {
            const skeletonsDir = L.skeletons;
            mkdirSync(skeletonsDir, { recursive: true });
            copyFileSync(draftPath, resolve(skeletonsDir, `${sk.id}.xml`));
            // Archive this command's PRD (the persistent intent) so amend/evolve can target it later.
            const prdsDir = resolve(target, PRDS); mkdirSync(prdsDir, { recursive: true });
            if (existsSync(resolve(target, PRD))) copyFileSync(resolve(target, PRD), resolve(prdsDir, `${sk.id}.md`));
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
          const id = parseDraft().sk?.id ?? "";
          const agentsPath = `reharness/agents/${id}`; // this command's private agent namespace
          const skillsNote = existsSync(resolve(target, SKILLS))
            ? ` Ground all external I/O and domain logic in the domain-skills at ${SKILLS}/*.md — use their Integration/I/O section for EXACT APIs/auth/endpoints; implement the documented integration, never improvise it from memory.`
            : ``;
          await Promise.all([
            c.agent("fill_prompts_md", `Fill the agent prompt stubs (<!-- TODO) in ${agentsPath}/<name>/SYSTEM.md from each agent state's <contract> in the skeleton. This command's agents live under ${agentsPath}/ — edit only SYSTEM.md files there.${skillsNote}`),
            c.agent("fill_prompts_lib", `Fill the code state stubs (// TODO) in reharness/lib/${id}-states.ts from each code state's <contract>. Read upstream stage outputs via c.dir('<stage>'). Edit only the lib .ts file.${skillsNote}`),
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
          const libPath = resolve(L.lib, `${sk.id}-states.ts`);
          const libSource = existsSync(libPath) ? readFileSync(libPath, "utf-8") : undefined;
          if (libSource) applyCodeDataIO(sk, extractCodeDataIO(libSource));
          const skPath = resolve(L.skeletons, `${sk.id}.xml`);
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
            ? ` Data-flow issues are in reharness/.cache/scratch/dataflow-errors.md (a node reads ctx.data not written on every path — insert an initialiser node on the path that lacks the writer).` : "";
          await c.agent("redesign",
            `Polish requested a skeleton-level change it could not make in the leaves:\n${reason}\n\n` +
            `Read reharness/.cache/scratch/_compiled.md.${dfNote} Stay faithful to the approved PRD at ${PRD} — fix HOW it's ` +
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
          const id = parseDraft().sk?.id ?? "";
          emitCompiledFromSkeletonsDir(reharnessDir, id); // scoped to the command being compiled
          if (existsSync(escalatePath)) writeFileSync(escalatePath, "");
          const dfNote = existsSync(dataflowErrorsPath) && readFileSync(dataflowErrorsPath, "utf-8").trim()
            ? ` Also resolve the data-flow issues listed in reharness/.cache/scratch/dataflow-errors.md.` : "";
          await c.agent("polish",
            `Review the generated pipeline (reharness/.cache/scratch/_compiled.md) against the approved PRD at ${PRD}, ` +
            `then fix what genuinely needs fixing — editing ONLY agent prompts (reharness/agents/${id}/<name>/SYSTEM.md) and code ` +
            `(reharness/lib/${id}-states.ts).${dfNote} If a fix requires a topology change you cannot make in the ` +
            `leaves, write the one-line reason to ${ESCALATE} and stop (do not edit the skeleton).`,
            { append: "_fsm-syntax" });
          const escalation = existsSync(escalatePath) ? readFileSync(escalatePath, "utf-8").trim() : "";
          if (escalation) {
            c.emit("↻ polish: topology change needed → redesign");
            // Carry the reason so the error terminal fails LOUD (invariant: total δ, no reasonless stall) when the
            // bounded escalate→redesign budget is exhausted — mirrors how `verify` sets data.error before FAIL.
            c.data.error = `polish escalated a topology change redesign could not resolve within ${CORRECTION_RETRIES} attempt(s): ${escalation.split("\n")[0].slice(0, 200)}`;
            c.retry("polish");
            return "ESCALATE";
          }
          delete c.data.error; // polish succeeded — clear any stale escalation reason before proceeding to verify
          c.emit("✓ polish done");
          return "DONE";
        },
        timeoutMs: 720_000,
        on: {
          DONE: "verify",
          TIMEOUT: "verify", // hard backstop: proceed to the deterministic gate, partial fixes and all
          ESCALATE: [
            { target: "redesign", guard: (c) => c.retries("polish") < CORRECTION_RETRIES },
            { target: "error" },
          ],
        },
      },

      verify: {
        entry: async (c) => {
          const errs = verifyGenerated(target);
          if (errs.length === 0) {
            if (existsSync(verifyErrorsPath)) writeFileSync(verifyErrorsPath, "");
            delete c.data.error;                                    // clear any stale verify reason on pass
            c.emit("✓ verify passed");
            return "PASS";
          }
          mkdirSync(genDir, { recursive: true });
          writeFileSync(verifyErrorsPath, errs.join("\n\n"));
          // Surface the reason so the error terminal fails loud (not "no reason set") if fixes are exhausted.
          const first = errs[0].split("\n").find((l) => l.trim())?.slice(0, 200) ?? "";
          c.data.error = `verify: ${errs.length} error(s) — see reharness/.cache/scratch/verify-errors.md; first: ${first}`;
          c.retry("verify");
          c.emit(`✗ verify: ${errs.length} error(s)`);
          return "FAIL";
        },
        on: {
          // generate ends at a verified base (fast & cheap). The enhance layer is a SEPARATE self-hosted
          // pipeline (src/compiler/enhance.ts), auto-chained by the runner unless --fast/--no-enhance, or run
          // on demand via `reharness enhance` — so it gets its own correctness gate (verify_harness).
          PASS: "done",
          FAIL: [
            { target: "fix_verify", guard: (c) => c.retries("verify") < CORRECTION_RETRIES },
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
            `The generated pipeline fails verification (TypeScript / FSM load). Read reharness/.cache/scratch/verify-errors.md and ` +
            `fix the errors in reharness/lib/${id}-states.ts. Edit ONLY that file; minimal edits.`,
            { model: LIGHT_MODEL });
        },
        on: "verify",
      },

      done: {
        type: "final", status: "success",
        entry: async (c) => {
          c.emit(`✓ pipeline ready in ${reharnessDir}`);
          const m = deriveManifest(reharnessDir); // writes manifest.json + setup.sh; the compiler never installs
          if (m.npm.length) c.emit(`ℹ npm deps: ${m.npm.join(", ")}`);
          if (m.tools.length) c.emit(`ℹ CLI tools: ${m.tools.join(", ")}`);
          if (m.env.length) c.emit(`ℹ env vars: ${m.env.join(", ")}`);
          if (m.npm.length || m.tools.length || m.env.length) c.emit("→ resolve deps: run reharness/setup.sh (host) or build reharness/Dockerfile (container)");
        },
      },
      error: { type: "final", status: "error" },
    },
  });
}

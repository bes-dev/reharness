import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { definePipeline } from "../runtime/fsm.js";
import type { Pipeline } from "../runtime/types.js";
import { parseSkeletonXML } from "./xml.js";
import { validateSkeleton } from "./schema.js";
import { generateAllFromSkeletons, emitCompiledFromSkeletonsDir } from "./codegen.js";
import { verifyGenerated } from "./verify.js";

const BUILTIN_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "agents");
const RESERVED_IDS = new Set(["generate", "evolve"]);

const PLAN = ".reharness/generate/plan.md";
const SCOPE = ".reharness/generate/scope.md";
const DRAFT = ".reharness/generate/draft-skeleton.xml";
const REVIEW = ".reharness/generate/review-report.md";

export interface GenerateOptions {
  cwd: string;
  input: string;
  fast?: boolean;
}

/** Self-hosted FSM that compiles a workflow from a natural-language description. */
export function buildGeneratePipeline(opts: GenerateOptions): Pipeline {
  const target = opts.cwd;
  const reharnessDir = resolve(target, ".reharness");
  const genDir = resolve(reharnessDir, "generate");
  const draftPath = resolve(target, DRAFT);
  const reviewReportPath = resolve(target, REVIEW);
  const verifyErrorsPath = resolve(genDir, "verify-errors.md");
  const fast = !!opts.fast;

  return definePipeline({
    config: { target, input: opts.input, fast },
    initial: "analyze",
    cwd: target,
    agents: BUILTIN_AGENTS_DIR,
    logsDir: resolve(reharnessDir, "logs"),

    states: {
      analyze: {
        entry: async (c) => {
          mkdirSync(genDir, { recursive: true });
          const fastNote = c.config.fast
            ? `\n\nFAST MODE: skip the web research step entirely. Rely only on training knowledge for domain enrichment. Mark every suggested addition in plan.md with "[fast mode — training-knowledge only]" so the user knows the sources are not verified.`
            : "";
          await c.agent("analyze",
            `Design and enrich a reharness FSM workflow for:\n\n${c.config.input}\n\n` +
            `Write THREE artifacts to .reharness/generate/: plan.md (human-readable, shown at approval), ` +
            `scope.md (technical LLM-spec), draft-skeleton.xml (codegen XML). ` +
            `The plan.md must enumerate core features + suggested best-practice additions separately, so the user can drop additions they don't want.` +
            fastNote,
          );
        },
        on: "review_design",
      },

      review_design: {
        type: "approval",
        prompt: "Review the plan. Approve to proceed, or revise to enter an interactive refinement session (where you can drop suggested features, rename steps, etc).",
        artifacts: [PLAN],
        autoEvent: "APPROVED",
        on: { APPROVED: "construct", REVISED: "discuss" },
      },

      discuss: {
        entry: async (c) => {
          await c.interactive("discuss",
            `The user rejected the current plan. Discuss what needs to change and update ${PLAN}, ${SCOPE}, and ${DRAFT} consistently. ` +
            `Edit ONLY those three files. Original task:\n\n${c.config.input}`,
            { artifacts: [PLAN, SCOPE, DRAFT] },
          );
        },
        on: "review_design",
      },

      construct: {
        entry: async (c) => {
          if (!existsSync(draftPath)) { c.emit("✗ draft-skeleton.xml missing"); return "ERROR"; }
          try {
            const sk = parseSkeletonXML(readFileSync(draftPath, "utf-8"));
            const errs = validateSkeleton(sk);
            if (errs.length) {
              writeFileSync(resolve(genDir, "skeleton-errors.md"), errs.join("\n"));
              c.emit(`✗ skeleton invalid:\n${errs.map(e => "  - " + e).join("\n")}`);
              return "ERROR";
            }
            if (RESERVED_IDS.has(sk.id)) { c.emit(`✗ skeleton id '${sk.id}' is reserved`); return "ERROR"; }
            const skeletonsDir = resolve(reharnessDir, "skeletons");
            mkdirSync(skeletonsDir, { recursive: true });
            copyFileSync(draftPath, resolve(skeletonsDir, `${sk.id}.xml`));
            generateAllFromSkeletons(reharnessDir);
            c.emit(`✓ skeleton ${sk.id} compiled`);
            return "DONE";
          } catch (err: any) { c.emit(`✗ construct: ${err.message}`); return "ERROR"; }
        },
        on: { DONE: "fill_prompts", ERROR: "error" },
      },

      fill_prompts: {
        entry: async (c) => {
          const reviewFailed = existsSync(reviewReportPath)
            && readFileSync(reviewReportPath, "utf-8").trimStart().startsWith("FAIL");
          const verifyFailed = existsSync(verifyErrorsPath)
            && readFileSync(verifyErrorsPath, "utf-8").trim().length > 0;

          // Two halves run in parallel — agent prompts (.md) and lib code (.ts) are independent.
          const mdTask = reviewFailed
            ? `Address every issue in ${REVIEW} that mentions agents/*.md prompts. Edit ONLY .reharness/agents/*.md files.`
            : verifyFailed
              ? `Fix .reharness/agents/*.md issues from verify-errors.md. Edit only those.`
              : `Fill the agent prompt stubs (<!-- TODO) in .reharness/agents/*.md. Use ${SCOPE} as the spec. Edit only .md files.`;
          const libTask = reviewFailed
            ? `Address every issue in ${REVIEW} that mentions lib/*-states.ts code. Edit ONLY .reharness/lib/<id>-states.ts.`
            : verifyFailed
              ? `Fix .reharness/lib/*-states.ts issues from verify-errors.md. Edit only that file.`
              : `Fill the code state stubs (// TODO) in .reharness/lib/<id>-states.ts. Use ${SCOPE} as the spec. Edit only the lib .ts file.`;

          await Promise.all([
            c.agent("fill_prompts_md", mdTask),
            c.agent("fill_prompts_lib", libTask),
          ]);
        },
        on: "review",
      },

      review: {
        entry: async (c) => {
          // Refresh the single-file consolidated view so the agent reads ONE file instead of 17+.
          emitCompiledFromSkeletonsDir(reharnessDir);
          await c.agent("review",
            `Review the generated reharness FSM against its spec. ` +
            `Read ONLY .reharness/generate/_compiled.md — it consolidates scope + skeleton + every agent prompt + lib code into one document. ` +
            `Write your report to ${REVIEW} with the first line being exactly PASS or FAIL. ` +
            `Do not modify any other files.`);
          if (!existsSync(reviewReportPath)) {
            c.emit("✗ review-report.md missing — treating as FAIL");
            c.retry("review");
            return "FAIL";
          }
          const firstLine = readFileSync(reviewReportPath, "utf-8").trimStart().split(/\r?\n/)[0].trim();
          if (firstLine === "PASS") {
            c.emit("✓ review passed");
            return "PASS";
          }
          c.emit(`✗ review reports issues (first line: "${firstLine}")`);
          c.retry("review");
          return "FAIL";
        },
        on: {
          PASS: "verify",
          FAIL: [
            { target: "fill_prompts", guard: (c) => c.retries("review") < 2 },  // 1st FAIL → light retry
            { target: "redesign",     guard: (c) => c.retries("review") < 3 },  // 2nd FAIL → skeleton patch
            { target: "error" },                                                  // 3rd → give up
          ],
        },
      },

      redesign: {
        entry: async (c) => {
          await c.agent("redesign",
            `The review step found issues that require skeleton-level changes (not just prompt/lib edits). ` +
            `Read ${SCOPE}, ${DRAFT}, and ${REVIEW}. ` +
            `Edit ONLY ${DRAFT} (and optionally ${SCOPE} if the scope itself has an unrealizable claim). ` +
            `After your edit, the pipeline will re-run construct (regenerate codegen + stubs) then fill_prompts then review.`,
          );
        },
        on: "construct",
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
            { target: "fill_prompts", guard: (c) => c.retries("verify") < 2 },
            { target: "error" },
          ],
        },
      },

      done: { type: "final", status: "success", entry: async (c) => { c.emit(`✓ pipeline ready in ${reharnessDir}`); } },
      error: { type: "final", status: "error" },
    },
  });
}

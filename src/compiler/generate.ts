import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { definePipeline } from "../runtime/fsm.js";
import type { Pipeline } from "../runtime/types.js";
import { parseSkeletonXML } from "./xml.js";
import { validateSkeleton } from "./schema.js";
import { generateAllFromSkeletons } from "./codegen.js";
import { verifyGenerated } from "./verify.js";

const BUILTIN_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "agents");
const RESERVED_IDS = new Set(["generate", "evolve"]);

const SCOPE = ".reharness/generate/scope.md";
const DRAFT = ".reharness/generate/draft-skeleton.xml";
const REVIEW = ".reharness/generate/review-report.md";

export interface GenerateOptions {
  cwd: string;
  input: string;
}

/** Self-hosted FSM that compiles a workflow from a natural-language description. */
export function buildGeneratePipeline(opts: GenerateOptions): Pipeline {
  const target = opts.cwd;
  const reharnessDir = resolve(target, ".reharness");
  const genDir = resolve(reharnessDir, "generate");
  const draftPath = resolve(target, DRAFT);
  const reviewReportPath = resolve(target, REVIEW);
  const verifyErrorsPath = resolve(genDir, "verify-errors.md");

  return definePipeline({
    config: { target, input: opts.input },
    initial: "analyze",
    cwd: target,
    agents: BUILTIN_AGENTS_DIR,
    logsDir: resolve(reharnessDir, "logs"),

    states: {
      analyze: {
        entry: async (c) => {
          mkdirSync(genDir, { recursive: true });
          await c.agent("analyze",
            `Design a reharness FSM workflow for:\n\n${c.config.input}\n\n` +
            `Write \`${SCOPE}\` and \`${DRAFT}\`.`,
          );
        },
        on: "review_design",
      },

      review_design: {
        type: "approval",
        prompt: "Review the proposed scope and draft skeleton. Approve to proceed, or revise to enter an interactive refinement session.",
        artifacts: [SCOPE, DRAFT],
        autoEvent: "APPROVED",
        on: { APPROVED: "construct", REVISED: "discuss" },
      },

      discuss: {
        entry: async (c) => {
          await c.interactive("discuss",
            `The user rejected the current draft. Discuss what needs to change and update ${SCOPE} and ${DRAFT}. ` +
            `Edit ONLY those two files. Original task:\n\n${c.config.input}`,
            { artifacts: [SCOPE, DRAFT] },
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

          const task = reviewFailed
            ? `Address every issue listed in ${REVIEW}. Modify only the prompts (agents/*.md) or code states (lib/*-states.ts) — do not edit skeletons or commands. Then exit; the runtime will re-review.`
            : verifyFailed
              ? `Fix the verify errors listed in .reharness/generate/verify-errors.md. Modify only the relevant prompts or code state implementations.`
              : `Fill the agent prompt stubs (<!-- TODO) in .reharness/agents/*.md and the code state stubs (// TODO) in .reharness/lib/*-states.ts. Use ${SCOPE} as the spec.`;
          await c.agent("fill_prompts", task);
        },
        on: "review",
      },

      review: {
        entry: async (c) => {
          await c.agent("review",
            `Review the generated reharness FSM against the spec at ${SCOPE}. ` +
            `Read all of: .reharness/skeletons/*.xml, .reharness/agents/*.md, .reharness/lib/*-states.ts. ` +
            `Write your report to ${REVIEW} with the first line being exactly PASS or FAIL. ` +
            `Do not modify any other files.`);
          if (!existsSync(reviewReportPath)) {
            c.emit("✗ review-report.md missing — treating as FAIL");
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
            { target: "fill_prompts", guard: (c) => c.retries("review") < 2 },
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

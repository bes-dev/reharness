import { createInterface } from "readline";
import { buildGeneratePipeline } from "./generate.js";
import type { ApprovalHandler } from "../runtime/types.js";
import { ansi, emit } from "../term.js";

export interface RunGenerateOptions {
  cwd: string;
  input: string;
  autoApprove?: boolean;
  piModel?: string;
  fast?: boolean;
}

export async function runGenerate(opts: RunGenerateOptions): Promise<number> {
  if (!opts.input.trim()) { console.error("Usage: reharness generate <description>"); return 1; }
  process.on("SIGINT", () => { process.stdout.write("\r\x1b[K"); process.exit(130); });

  const pipeline = buildGeneratePipeline(opts);
  try {
    const status = await pipeline.run(emit, {
      autoApprove: opts.autoApprove,
      approvalHandler: terminalApprovalHandler,
      piModel: opts.piModel,
    });
    process.stdout.write("\r\x1b[K");
    console.log(status === "success" ? ansi.green("✓ generate complete") : ansi.red(`✗ ${status}`));
    return status === "success" ? 0 : 1;
  } catch (err: any) {
    process.stdout.write("\r\x1b[K");
    console.log(`${ansi.red("✗ crashed:")} ${err.message}`);
    return 1;
  }
}

const terminalApprovalHandler: ApprovalHandler = async (cp) => {
  const { dim, bold, cyan, red } = ansi;
  const sep = dim("─".repeat(60));
  console.log(`\n${sep}\n${bold(cyan("◆ APPROVAL"))} ${dim(`(${cp.state}, round ${cp.round})`)}\n\n${cp.prompt}\n`);
  for (const a of cp.artifacts) {
    console.log(dim(`── ${a.path} ──`));
    console.log(a.content.length > 4000 ? a.content.slice(0, 4000) + dim("\n[…truncated]") : a.content);
    console.log("");
  }
  console.log(`Events: ${cp.events.map(e => e === cp.autoEvent ? bold(e) : e).join(" | ")}\n${sep}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  try {
    while (true) {
      const ev = ((await ask(`Event [${cp.autoEvent || cp.events[0]}]: `)).trim()) || cp.autoEvent || cp.events[0];
      if (!cp.events.includes(ev)) { console.log(red(`Unknown event "${ev}". Allowed: ${cp.events.join(", ")}`)); continue; }
      return { event: ev };
    }
  } finally { rl.close(); }
};

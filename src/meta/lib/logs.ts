import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { resolve } from "path";

/**
 * Write a minimal investigation brief: paths and status only.
 * The investigator agent reads raw data from these paths.
 */
export function writeInvestigationBrief(projectDir: string, outputPath: string): number {
  const lines: string[] = ["# Investigation Brief\n"];
  lines.push(`## Project: ${projectDir}`);

  const reharnessDir = resolve(projectDir, ".reharness");
  lines.push(`## .reharness/: ${existsSync(reharnessDir) ? "exists" : "MISSING"}\n`);

  const logDirs = findLogDirs(projectDir);
  let runCount = 0;

  lines.push("## Run Logs\n");
  for (const logsDir of logDirs) {
    let runs: string[];
    try { runs = readdirSync(logsDir).filter(d => d.startsWith("run-")).sort().reverse(); } catch { continue; }

    for (const runDir of runs) {
      const full = resolve(logsDir, runDir);
      const statePath = resolve(full, "state.json");
      if (!existsSync(statePath)) continue;
      runCount++;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        const completed = state.current === "__done__";
        lines.push(`### ${runDir}`);
        lines.push(`- Path: ${full}`);
        lines.push(`- State: ${state.current} ${completed ? "(completed)" : "(NOT completed)"}`);
        lines.push(`- Retries: ${JSON.stringify(state.retries || {})}`);

        let logFiles: string[];
        try { logFiles = readdirSync(full).filter(f => f.endsWith(".md")).sort(); } catch { logFiles = []; }
        if (logFiles.length) lines.push(`- Agent logs: ${logFiles.join(", ")}`);
        lines.push("");
      } catch { /* corrupt state.json — skip run */ }
    }
  }

  if (runCount === 0) {
    lines.push("No run logs found.\n");
  }

  if (existsSync(reharnessDir)) {
    lines.push("## .reharness/ Files\n");
    lines.push(listReharnessFiles(reharnessDir));
    lines.push("");
  }

  writeFileSync(outputPath, lines.join("\n"));
  return runCount;
}

function findLogDirs(projectDir: string): string[] {
  const dirs: string[] = [];
  const directLogs = resolve(projectDir, "logs");
  if (existsSync(directLogs)) dirs.push(directLogs);

  try {
    for (const sub of readdirSync(projectDir)) {
      if (sub.startsWith(".") || sub === "node_modules") continue;
      const subLogs = resolve(projectDir, sub, "logs");
      try {
        if (existsSync(subLogs) && readdirSync(subLogs).some(d => d.startsWith("run-"))) {
          dirs.push(subLogs);
        }
      } catch { /* unreadable subdir — skip */ }
    }
  } catch { /* unreadable projectDir — return what we have */ }

  return dirs;
}

function listReharnessFiles(dir: string, prefix = ""): string {
  const lines: string[] = [];
  try {
    for (const name of readdirSync(dir).sort()) {
      const full = resolve(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (existsSync(full) && statSync(full).isDirectory()) {
        lines.push(...listReharnessFiles(full, rel).split("\n").filter(Boolean));
      } else {
        lines.push(`- .reharness/${rel}`);
      }
    }
  } catch { /* unreadable dir — skip */ }
  return lines.join("\n");
}

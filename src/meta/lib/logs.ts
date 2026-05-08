import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { resolve } from "path";

export interface RunLog {
  runId: string;
  current: string;
  retries: Record<string, number>;
  data: Record<string, any>;
  verifyReport?: string;
  fixLogs: string[];
}

export function readProjectLogs(projectDir: string): RunLog[] {
  const logs: RunLog[] = [];

  // Find all log directories: direct logs/ or nested (e.g. apps/slug/logs/)
  const logDirs = findLogDirs(projectDir);

  for (const logsDir of logDirs) {
    const runs = readdirSync(logsDir)
      .filter(d => d.startsWith("run-"))
      .sort()
      .reverse();

    for (const runDir of runs) {
      const full = resolve(logsDir, runDir);
      const statePath = resolve(full, "state.json");
      if (!existsSync(statePath)) continue;

      try {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        const log: RunLog = {
          runId: state.runId || runDir,
          current: state.current || "unknown",
          retries: state.retries || {},
          data: state.data || {},
          fixLogs: [],
        };

        // Look for verify-report.md in project dir (common locations)
        for (const reportPath of [
          resolve(projectDir, "verify-report.md"),
          resolve(full, "..", "..", "verify-report.md"),
        ]) {
          if (existsSync(reportPath)) {
            log.verifyReport = readFileSync(reportPath, "utf-8").slice(0, 5000);
            break;
          }
        }

        // Read fix agent logs
        const logFiles = readdirSync(full).filter(f => f.includes("fix") && f.endsWith(".md")).sort();
        for (const f of logFiles) {
          log.fixLogs.push(readFileSync(resolve(full, f), "utf-8").slice(0, 3000));
        }

        logs.push(log);
      } catch {}
    }
  }

  return logs;
}

export function formatEvolutionInput(projectDir: string, logs: RunLog[]): string {
  const lines: string[] = ["# Evolution Input\n"];

  lines.push(`## Summary\n- Total runs: ${logs.length}`);

  const completed = logs.filter(l => l.current === "__done__").length;
  const failed = logs.filter(l => l.current !== "__done__").length;
  lines.push(`- Completed: ${completed}`);
  lines.push(`- Failed/interrupted: ${failed}\n`);

  // Retry analysis
  const retryStats: Record<string, number[]> = {};
  for (const log of logs) {
    for (const [key, count] of Object.entries(log.retries)) {
      if (!retryStats[key]) retryStats[key] = [];
      retryStats[key].push(count);
    }
  }
  if (Object.keys(retryStats).length) {
    lines.push("## Retry Patterns\n");
    for (const [key, counts] of Object.entries(retryStats)) {
      const avg = (counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1);
      const max = Math.max(...counts);
      lines.push(`- **${key}**: avg ${avg}, max ${max} (across ${counts.length} runs)`);
    }
    lines.push("");
  }

  // Latest verify report
  const latestWithReport = logs.find(l => l.verifyReport);
  if (latestWithReport?.verifyReport) {
    lines.push("## Latest Verify Report\n");
    lines.push(latestWithReport.verifyReport);
    lines.push("");
  }

  // Fix agent patterns
  const allFixLogs = logs.flatMap(l => l.fixLogs);
  if (allFixLogs.length) {
    lines.push(`## Fix Agent Logs (${allFixLogs.length} total)\n`);
    // Show last 3
    for (const log of allFixLogs.slice(-3)) {
      lines.push("---\n");
      lines.push(log);
      lines.push("");
    }
  }

  // List all .pi-fsm files for context
  lines.push("## Current Pipeline Files\n");
  const piFsmDir = resolve(projectDir, ".pi-fsm");
  if (existsSync(piFsmDir)) {
    lines.push(listPiFsmFiles(piFsmDir));
  } else {
    lines.push("No .pi-fsm/ directory found.\n");
  }

  return lines.join("\n");
}

function findLogDirs(projectDir: string): string[] {
  const dirs: string[] = [];
  const directLogs = resolve(projectDir, "logs");
  if (existsSync(directLogs)) dirs.push(directLogs);

  // Check one level deep for nested logs (e.g. apps/*/logs/)
  try {
    for (const sub of readdirSync(projectDir)) {
      if (sub.startsWith(".") || sub === "node_modules") continue;
      const subLogs = resolve(projectDir, sub, "logs");
      if (existsSync(subLogs) && readdirSync(subLogs).some(d => d.startsWith("run-"))) {
        dirs.push(subLogs);
      }
    }
  } catch {}

  return dirs;
}

function listPiFsmFiles(dir: string, prefix = ""): string {
  const lines: string[] = [];
  try {
    for (const name of readdirSync(dir).sort()) {
      const full = resolve(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (existsSync(full) && statSync(full).isDirectory()) {
        lines.push(...listPiFsmFiles(full, rel).split("\n").filter(Boolean));
      } else {
        lines.push(`- .pi-fsm/${rel}`);
      }
    }
  } catch {}
  return lines.join("\n");
}

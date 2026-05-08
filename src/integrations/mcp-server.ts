#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { z } from "zod";

const cwd = process.cwd();

function run(cmd: string, timeout = 300000): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err: any) {
    return err.stdout || err.stderr || err.message;
  }
}

const server = new McpServer({
  name: "reharness",
  version: "0.3.0",
});

server.tool(
  "reharness_generate",
  "Generate a reharness pipeline from a natural language description. Use outputDir for standalone pipelines (new directory), omit it to generate commands in the current project.",
  {
    description: z.string().describe("What the pipeline should do"),
    outputDir: z.string().optional().describe("Output directory for standalone pipeline (e.g. ./my-pipeline). Omit to generate in current project."),
    model: z.string().optional().describe("LLM model to use (e.g. anthropic/claude-sonnet-4-6)"),
  },
  async ({ description, outputDir, model }) => {
    const args = outputDir ? `${outputDir} ${description}` : description;
    const modelFlag = model ? ` --model ${model}` : "";
    const output = run(`reharness generate ${args}${modelFlag}`);
    return { content: [{ type: "text" as const, text: output }] };
  },
);

server.tool(
  "reharness_evolve",
  "Analyze pipeline run logs and improve the pipeline. Patches agent prompts, verify checks, scaffold, and state graph. Changes are git-versioned for rollback.",
  {
    auto: z.boolean().optional().describe("Enable auto-evolution after every future run"),
    model: z.string().optional().describe("LLM model to use"),
  },
  async ({ auto, model }) => {
    const flags = [auto ? "--auto" : "", model ? `--model ${model}` : ""].filter(Boolean).join(" ");
    const output = run(`reharness evolve ${flags}`);
    return { content: [{ type: "text" as const, text: output }] };
  },
);

server.tool(
  "reharness_run",
  "Run a reharness pipeline command in the current project. Use reharness_list first to see available commands.",
  {
    command: z.string().describe("Command name (e.g. build, review, test-gen)"),
    args: z.array(z.string()).optional().describe("Arguments for the command"),
    model: z.string().optional().describe("LLM model to use"),
  },
  async ({ command, args, model }) => {
    const cmdArgs = args?.join(" ") || "";
    const modelFlag = model ? ` --model ${model}` : "";
    const output = run(`reharness ${command} ${cmdArgs}${modelFlag}`);
    return { content: [{ type: "text" as const, text: output }] };
  },
);

server.tool(
  "reharness_list",
  "List available reharness commands in the current project. Returns built-in commands (generate, evolve) plus project-specific commands from .reharness/commands/.",
  {},
  async () => {
    const commands: Record<string, string> = {
      generate: "Generate a reharness pipeline from a prompt",
      evolve: "Analyze run logs and improve pipeline",
    };

    const commandsDir = resolve(cwd, ".reharness", "commands");
    if (existsSync(commandsDir)) {
      for (const file of readdirSync(commandsDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"))) {
        const name = file.replace(/\.(ts|js)$/, "");
        if (!commands[name]) {
          commands[name] = `Project command: ${name}`;
        }
      }
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(commands, null, 2) }] };
  },
);

server.tool(
  "reharness_status",
  "Get the status of the last pipeline run in the current project. Shows completion state, retry counts, and any verify errors.",
  {},
  async () => {
    const result: Record<string, any> = { project: cwd, hasReharness: existsSync(resolve(cwd, ".reharness")) };

    // Find latest run
    const logDirs = [resolve(cwd, "logs"), resolve(cwd, ".reharness", "logs")];
    for (const logDir of logDirs) {
      if (!existsSync(logDir)) continue;
      const runs = readdirSync(logDir).filter(d => d.startsWith("run-")).sort().reverse();
      if (runs.length === 0) continue;

      const latestRun = resolve(logDir, runs[0]);
      const statePath = resolve(latestRun, "state.json");
      if (existsSync(statePath)) {
        try {
          const state = JSON.parse(readFileSync(statePath, "utf-8"));
          result.lastRun = {
            id: state.runId,
            state: state.current,
            completed: state.current === "__done__",
            retries: state.retries,
          };
        } catch {}
      }
      break;
    }

    // Check for verify report
    const reportPath = resolve(cwd, "verify-report.md");
    if (existsSync(reportPath)) {
      result.verifyReport = readFileSync(reportPath, "utf-8").slice(0, 2000);
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();

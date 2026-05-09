#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { z } from "zod";

const cwd = process.cwd();

/** Run reharness CLI safely — no shell interpolation. */
function run(args: string[], timeout = 300000): string {
  try {
    return execFileSync("reharness", args, { cwd, encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return e.stdout || e.stderr || e.message || "Unknown error";
  }
}

const server = new McpServer({
  name: "reharness",
  version: "0.3.0",
});

server.tool(
  "reharness_generate",
  "Generate a reharness FSM from a natural language description.",
  {
    description: z.string().describe("What the FSM should do"),
    outputDir: z.string().optional().describe("Output directory for standalone FSM"),
    model: z.string().optional().describe("LLM model to use"),
  },
  async ({ description, outputDir, model }) => {
    const args = ["generate"];
    if (outputDir) args.push(outputDir);
    args.push(description);
    if (model) args.push("--model", model);
    const output = run(args);
    return { content: [{ type: "text" as const, text: output }] };
  },
);

server.tool(
  "reharness_evolve",
  "Investigate FSM runs and improve the machine. Changes are git-versioned for rollback.",
  {
    interactive: z.boolean().optional().describe("Interactive investigation mode"),
    model: z.string().optional().describe("LLM model to use"),
  },
  async ({ interactive, model }) => {
    const args = ["evolve"];
    if (interactive) args.push("--interactive");
    if (model) args.push("--model", model);
    const output = run(args);
    return { content: [{ type: "text" as const, text: output }] };
  },
);

server.tool(
  "reharness_run",
  "Run a reharness FSM command in the current project.",
  {
    command: z.string().describe("Command name"),
    args: z.array(z.string()).optional().describe("Arguments for the command"),
    model: z.string().optional().describe("LLM model to use"),
  },
  async ({ command, args: cmdArgs, model }) => {
    const args = [command, ...(cmdArgs || [])];
    if (model) args.push("--model", model);
    const output = run(args);
    return { content: [{ type: "text" as const, text: output }] };
  },
);

server.tool(
  "reharness_list",
  "List available reharness commands in the current project.",
  {},
  async () => {
    const commands: Record<string, string> = {
      generate: "Generate a reharness FSM from a prompt",
      evolve: "Investigate runs and improve FSM",
    };

    const commandsDir = resolve(cwd, ".reharness", "commands");
    if (existsSync(commandsDir)) {
      for (const file of readdirSync(commandsDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"))) {
        const name = file.replace(/\.(ts|js)$/, "");
        if (!commands[name]) commands[name] = `Project command: ${name}`;
      }
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(commands, null, 2) }] };
  },
);

server.tool(
  "reharness_status",
  "Get the status of the last FSM run in the current project.",
  {},
  async () => {
    const result: Record<string, unknown> = { project: cwd, hasReharness: existsSync(resolve(cwd, ".reharness")) };

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
        } catch { /* corrupt state.json */ }
      }
      break;
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();

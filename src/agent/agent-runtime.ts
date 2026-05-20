/**
 * Agent runtime — replaces Pi subprocess for FSM agent states.
 * Uses pi-agent-core's Agent with state save/restore per FSM state.
 */

import type { Agent, AgentTool, AgentMessage } from "@earendil-works/pi-agent-core";
import { loadHarness } from "./harness-loader.js";
import { validateInputContract, validateOutputContract } from "./contract-validator.js";

export interface AgentRuntimeOpts {
  model?: string;
  logFile?: string;
  onLine?: (msg: string) => void;
  onStatus?: (text: string) => void;
  signal?: AbortSignal;
}

export interface AgentRuntimeConfig {
  agent: Agent;
  agentsDir: string;
  baseTools: AgentTool[];
  cwd: string;
}

export class AgentRuntime {
  private agent: Agent;
  private agentsDir: string;
  private baseTools: AgentTool[];
  private cwd: string;

  constructor(config: AgentRuntimeConfig) {
    this.agent = config.agent;
    this.agentsDir = config.agentsDir;
    this.baseTools = config.baseTools;
    this.cwd = config.cwd;
  }

  async runAgent(name: string, task: string, opts?: AgentRuntimeOpts): Promise<void> {
    const harness = await loadHarness(this.agentsDir, name);

    // Save current state
    const savedTools = [...this.agent.state.tools];
    const savedPrompt = this.agent.state.systemPrompt;
    const savedMessages = [...this.agent.state.messages];

    try {
      // Build tool set: filter base tools + add extensions
      let tools: AgentTool[];
      if (harness.allowedTools) {
        const allowed = new Set(harness.allowedTools);
        tools = this.baseTools.filter(t => allowed.has(t.name));
      } else {
        tools = [...this.baseTools];
      }
      tools.push(...harness.extensions);

      // Swap agent state
      this.agent.state.tools = tools;
      this.agent.state.systemPrompt = harness.systemPrompt;
      this.agent.state.messages = [];

      // Validate input contract
      if (harness.contract) {
        const inputErrors = validateInputContract(harness.contract, this.cwd);
        if (inputErrors.length > 0) {
          throw new Error(`Input contract failed:\n${inputErrors.join("\n")}`);
        }
      }

      // Subscribe to events for logging
      let unsubscribe: (() => void) | undefined;
      if (opts?.onLine) {
        const onLine = opts.onLine;
        unsubscribe = this.agent.subscribe((event) => {
          if (event.type === "tool_execution_start") {
            const e = event as any;
            onLine(`  ⏳ ${e.toolName || "tool"}`);
          } else if (event.type === "tool_execution_end") {
            const e = event as any;
            if (e.isError) onLine(`  ✗ ${e.toolName || "tool"}`);
            else onLine(`  ✓ ${e.toolName || "tool"}`);
          }
        });
      }

      // Run
      await this.agent.prompt(task);

      // Cleanup subscription
      unsubscribe?.();

      // Validate output contract
      if (harness.contract) {
        const outputErrors = validateOutputContract(harness.contract, this.cwd);
        if (outputErrors.length > 0) {
          throw new Error(`Output contract failed:\n${outputErrors.join("\n")}`);
        }
      }
    } finally {
      // Restore state
      this.agent.state.tools = savedTools;
      this.agent.state.systemPrompt = savedPrompt;
      this.agent.state.messages = savedMessages;
    }
  }

  async runInteractive(name: string, task: string, opts?: AgentRuntimeOpts): Promise<void> {
    // For now, interactive = same as agent (no tmux)
    await this.runAgent(name, task, opts);
  }
}

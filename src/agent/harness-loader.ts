/**
 * Load per-agent harness configuration.
 *
 * Two formats:
 *   agents/name.md       → prompt-only (all tools, no contract)
 *   agents/name/         → full harness (prompt.md, tools.json, extensions/, contract.json)
 */

import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { loadExtensions } from "./extension-loader.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface FileContract {
  path: string;
  minSize?: number;
  contains?: string;
}

export interface ContractSpec {
  inputs?: FileContract[];
  outputs?: FileContract[];
}

export interface AgentHarness {
  name: string;
  systemPrompt: string;
  allowedTools: string[] | null;  // null = all tools
  extensions: AgentTool[];
  contract: ContractSpec | null;
}

export async function loadHarness(agentsDir: string, name: string): Promise<AgentHarness> {
  const dirPath = join(agentsDir, name);
  const filePath = join(agentsDir, `${name}.md`);

  // Directory harness
  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
    const promptFile = join(dirPath, "prompt.md");
    if (!existsSync(promptFile)) throw new Error(`${dirPath}/prompt.md not found`);

    const systemPrompt = readFileSync(promptFile, "utf-8");

    let allowedTools: string[] | null = null;
    const toolsFile = join(dirPath, "tools.json");
    if (existsSync(toolsFile)) {
      allowedTools = JSON.parse(readFileSync(toolsFile, "utf-8"));
    }

    const extensionsDir = join(dirPath, "extensions");
    const extensions = existsSync(extensionsDir) ? await loadExtensions(extensionsDir) : [];

    let contract: ContractSpec | null = null;
    const contractFile = join(dirPath, "contract.json");
    if (existsSync(contractFile)) {
      contract = JSON.parse(readFileSync(contractFile, "utf-8"));
    }

    return { name, systemPrompt, allowedTools, extensions, contract };
  }

  // File-only harness (backward compat)
  if (existsSync(filePath)) {
    return {
      name,
      systemPrompt: readFileSync(filePath, "utf-8"),
      allowedTools: null,
      extensions: [],
      contract: null,
    };
  }

  throw new Error(`Agent "${name}" not found in ${agentsDir}`);
}

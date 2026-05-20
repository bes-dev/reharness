/**
 * Dynamic import of .ts tool extensions from an agent's extensions/ directory.
 * Each file exports a default AgentTool or array of AgentTool.
 */

import { readdirSync } from "fs";
import { join, resolve } from "path";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export async function loadExtensions(extensionsDir: string): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  const files = readdirSync(extensionsDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"));

  for (const file of files) {
    try {
      const mod = await import(resolve(extensionsDir, file));
      const exported = mod.default;
      if (Array.isArray(exported)) {
        tools.push(...exported);
      } else if (exported?.name && exported?.execute) {
        tools.push(exported);
      }
    } catch (err: any) {
      console.error(`⚠ Failed to load extension ${file}: ${err.message}`);
    }
  }

  return tools;
}

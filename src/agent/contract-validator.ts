/**
 * Validate input/output file contracts for agent states.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import type { ContractSpec, FileContract } from "./harness-loader.js";

function validateFiles(contracts: FileContract[], cwd: string, label: string): string[] {
  const errors: string[] = [];
  for (const c of contracts) {
    const filePath = resolve(cwd, c.path);
    if (!existsSync(filePath)) {
      errors.push(`${label}: ${c.path} does not exist`);
      continue;
    }
    if (c.minSize !== undefined) {
      const size = statSync(filePath).size;
      if (size < c.minSize) {
        errors.push(`${label}: ${c.path} is ${size} bytes (need ≥${c.minSize})`);
      }
    }
    if (c.contains) {
      const content = readFileSync(filePath, "utf-8");
      if (!content.includes(c.contains)) {
        errors.push(`${label}: ${c.path} does not contain "${c.contains}"`);
      }
    }
  }
  return errors;
}

export function validateInputContract(contract: ContractSpec, cwd: string): string[] {
  if (!contract.inputs?.length) return [];
  return validateFiles(contract.inputs, cwd, "Input contract");
}

export function validateOutputContract(contract: ContractSpec, cwd: string): string[] {
  if (!contract.outputs?.length) return [];
  return validateFiles(contract.outputs, cwd, "Output contract");
}

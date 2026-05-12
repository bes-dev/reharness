import { existsSync, readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { generateAllFromSkeletons } from "./codegen.js";

/** Snapshot all skeleton JSON contents for later change detection. */
export function snapshotSkeletons(skeletonsDir: string): Record<string, string> {
  if (!existsSync(skeletonsDir)) return {};
  const files = readdirSync(skeletonsDir).filter(f => f.endsWith('.json'));
  return Object.fromEntries(files.map(f => [f, readFileSync(resolve(skeletonsDir, f), 'utf-8')]));
}

/** Compare current skeletons against snapshot; regenerate commands if changed. Returns true if regenerated. */
export function regenIfChanged(skeletonsDir: string, reharnessDir: string, before: Record<string, string>): boolean {
  if (!existsSync(skeletonsDir)) return false;
  const currentFiles = readdirSync(skeletonsDir).filter(f => f.endsWith('.json'));
  if (currentFiles.length !== Object.keys(before).length) {
    generateAllFromSkeletons(reharnessDir);
    return true;
  }
  for (const file of currentFiles) {
    const now = readFileSync(resolve(skeletonsDir, file), 'utf-8');
    if (now !== before[file]) {
      generateAllFromSkeletons(reharnessDir);
      return true;
    }
  }
  return false;
}

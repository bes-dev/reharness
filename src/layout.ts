import { resolve } from "path";

// The on-disk layout of a compiled-pipeline bundle — the SINGLE source of truth for every path reharness reads or
// writes. Like config.ts centralizes tuning knobs, this centralizes locations (they were scattered string literals).
//
// A bundle is a FIRST-CLASS, LIFTABLE deliverable: `mv reharness/ elsewhere` and it self-contains (its own
// package.json + node_modules link live at the bundle root). Two kinds of content, split by whether it's the product:
//   • DELIVERABLE (versioned, shipped): skeletons (source of truth), prds (approved intent), generated commands/lib,
//     agent prompts, skills, synthesized tools, the dependency manifest/setup.sh/Dockerfile.
//   • RUN-EXHAUST (regenerable, gitignorable): everything under `.cache/` — run state/trace/work (runs/), the evolve
//     utility ledger (evolve/), and transient compiler scratch (scratch/: PRD draft, skeleton draft, errors, …).

export const BUNDLE_DIR = "reharness"; // the bundle dir name (was the legacy dotfolder ".reharness")
export const CACHE_DIR = ".cache";     // run-exhaust under the bundle — safe to gitignore / delete

export interface Layout {
  root: string;        // the bundle (deliverable root)
  // deliverable
  skeletons: string; commands: string; lib: string; agents: string; skills: string; tools: string; prds: string;
  manifest: string; setup: string; dockerfile: string;
  // run-exhaust (under .cache/)
  cache: string; runs: string; evolve: string; scratch: string; feedback: string;
}

/** Build the layout from a bundle root (the deliverable dir itself). */
export function bundleAt(root: string): Layout {
  const cache = resolve(root, CACHE_DIR);
  return {
    root,
    skeletons: resolve(root, "skeletons"),
    commands: resolve(root, "commands"),
    lib: resolve(root, "lib"),
    agents: resolve(root, "agents"),
    skills: resolve(root, "skills"),
    tools: resolve(root, "tools"),
    prds: resolve(root, "prds"),
    manifest: resolve(root, "manifest.json"),
    setup: resolve(root, "setup.sh"),
    dockerfile: resolve(root, "Dockerfile"),
    cache,
    runs: resolve(cache, "runs"),
    evolve: resolve(cache, "evolve"),
    scratch: resolve(cache, "scratch"),
    feedback: resolve(cache, "feedback"),
  };
}

/** Build the layout from a PROJECT root (the dir that holds the bundle) — the common entry point. */
export function layout(projectRoot: string): Layout {
  return bundleAt(resolve(projectRoot, BUNDLE_DIR));
}

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { resolve } from "path";
import { builtinModules } from "module";
import { bundleAt } from "../layout.js";

/** node builtins (both bare and `node:`-prefixed) — never external deps. */
const BUILTINS = new Set<string>([...builtinModules, ...builtinModules.map(m => `node:${m}`)]);

/** Toolchain + shell built-ins that are always present — not real external CLI dependencies. */
const TOOL_DENY = new Set([
  "node", "npm", "npx", "yarn", "pnpm", "tsx",
  "cd", "ls", "cat", "echo", "mkdir", "rm", "cp", "mv", "touch", "grep", "sed", "awk", "find", "test", "true", "false", "which",
]);

/** Runtime/ambient env vars — not dependencies the user must provide. */
const ENV_DENY = new Set(["PATH", "HOME", "CI", "NODE_ENV", "TMPDIR", "TMP", "TEMP", "PWD", "SHELL", "USER", "LANG", "TERM"]);

/** External npm packages a lib imports — bare specifiers, minus node builtins and our own package. Subpaths
 *  collapse to the package: `pdfkit/js/x` → `pdfkit`, `@scope/pkg/sub` → `@scope/pkg`. */
export function externalDeps(libSource: string): string[] {
  const out = new Set<string>();
  const add = (spec: string) => {
    if (spec.startsWith(".") || spec.startsWith("/")) return;           // relative/absolute — local
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (pkg === "reharness" || BUILTINS.has(pkg)) return;
    out.add(pkg);
  };
  for (const m of libSource.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) add(m[1]);        // import … from 'X'
  for (const m of libSource.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) add(m[1]);  // import('X') / await import('X')
  for (const m of libSource.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g)) add(m[1]); // require('X') — legacy/wrong form, real dep
  return [...out];
}

/** External CLI binaries a lib shells out to (`spawnSync('ffmpeg', …)`, `execSync('git clone …')`), minus the
 *  always-present toolchain/shell built-ins. The binary is the first token (basename) of the command. */
export function externalTools(libSource: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const bin = raw.trim().split(/\s+/)[0].split("/").pop() || "";       // first token, basename
    if (bin && !bin.startsWith("$") && !TOOL_DENY.has(bin)) out.add(bin);
  };
  for (const m of libSource.matchAll(/\b(?:spawnSync|spawn|execFileSync|execFile)\s*\(\s*['"`]([^'"`]+)['"`]/g)) add(m[1]); // bin is the first arg
  for (const m of libSource.matchAll(/\b(?:execSync|exec)\s*\(\s*['"`]([^'"`]+)['"`]/g)) add(m[1]);                       // bin is the first token of the command string
  return [...out];
}

/** Env vars a lib reads (`process.env.X`) — the config/secrets the user must provide; minus ambient ones. */
export function externalEnv(libSource: string): string[] {
  const out = new Set<string>();
  const add = (name: string) => { if (!ENV_DENY.has(name)) out.add(name); };
  for (const m of libSource.matchAll(/\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1]);
  for (const m of libSource.matchAll(/\bprocess\.env\[\s*['"]([^'"]+)['"]\s*\]/g)) add(m[1]);
  return [...out];
}

/** The pipeline's derived dependency inventory. `npm` is auto-installable (the emitted setup.sh); `tools` are
 *  external binaries (checked + surfaced — host-install is platform-specific); `env` are user-provided. */
export interface Manifest { npm: string[]; tools: string[]; env: string[] }

/**
 * Derive the capability manifest from every generated lib and write `reharness/manifest.json`. The compiler
 * SURFACES the full dependency inventory (cheap, always useful) and renders setup.sh + Dockerfile; actually
 * installing is an opt-in deployment step the user runs (the compiler never installs). Returns the manifest.
 */
export function deriveManifest(reharnessDir: string): Manifest {
  const libDir = bundleAt(reharnessDir).lib;
  const npm = new Set<string>(), tools = new Set<string>(), env = new Set<string>();
  for (const f of existsSync(libDir) ? readdirSync(libDir).filter(f => f.endsWith(".ts")) : []) {
    const src = readFileSync(resolve(libDir, f), "utf-8");
    externalDeps(src).forEach(d => npm.add(d));
    externalTools(src).forEach(t => tools.add(t));
    externalEnv(src).forEach(e => env.add(e));
  }
  const manifest: Manifest = { npm: [...npm].sort(), tools: [...tools].sort(), env: [...env].sort() };
  mkdirSync(reharnessDir, { recursive: true });
  writeFileSync(bundleAt(reharnessDir).manifest, JSON.stringify(manifest, null, 2) + "\n");
  writeSetupScript(reharnessDir, manifest);   // renderer 1: host install
  writeDockerfile(reharnessDir, manifest);    // renderer 2: reproducible container
  return manifest;
}

/**
 * Render the manifest as a runnable `reharness/setup.sh` — the conventional, transparent artifact the USER
 * reviews and runs to provision a host (the compiler never installs anything itself). It installs npm deps,
 * checks each CLI tool and reports any missing with an install hint, and lists the env vars to set. One script,
 * every ecosystem, fully editable — and the natural seed for a Dockerfile if reproducibility is later needed.
 * Removed (writes an empty marker) when the pipeline has no external deps. Returns the path, or null if none.
 */
export function writeSetupScript(reharnessDir: string, m: Manifest): string | null {
  const path = bundleAt(reharnessDir).setup;
  if (!m.npm.length && !m.tools.length && !m.env.length) {
    writeFileSync(path, "#!/usr/bin/env bash\n# reharness: this pipeline has no external dependencies.\n");
    chmodSync(path, 0o755);
    return null;
  }
  const l: string[] = [
    "#!/usr/bin/env bash",
    "# Generated by reharness — installs this pipeline's dependencies. Review before running.",
    "set -e",
    'cd "$(dirname "$0")/.."   # run from the project root (the dir holding reharness)',
    "",
  ];
  if (m.tools.length) {
    // Detect the host package manager so tool installs work cross-platform (mac/brew, debian/apt, fedora/dnf, …).
    l.push(
      "# ── detect a package manager for CLI tools (sudo only when not already root, e.g. inside a container) ──",
      'SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"',
      'if   command -v brew    >/dev/null 2>&1; then PM="brew install";',
      'elif command -v apt-get >/dev/null 2>&1; then PM="$SUDO apt-get install -y"; $SUDO apt-get update -qq || true;',
      'elif command -v dnf     >/dev/null 2>&1; then PM="$SUDO dnf install -y";',
      'elif command -v pacman  >/dev/null 2>&1; then PM="$SUDO pacman -S --noconfirm";',
      'elif command -v apk     >/dev/null 2>&1; then PM="$SUDO apk add";',
      'else PM=""; fi',
      "",
      "install_tool() {",
      '  command -v "$1" >/dev/null 2>&1 && { echo "✓ $1"; return; }',
      '  if [ -n "$PM" ]; then echo "installing $1…"; $PM "$1" || echo "✗ could not install $1 — install it manually (package name may differ from the binary)";',
      '  else echo "✗ $1 missing and no known package manager — install it manually"; fi',
      "}",
      "",
    );
  }
  if (m.npm.length) l.push("# ── npm packages ──", `npm install ${m.npm.join(" ")}`, "");
  if (m.tools.length) {
    l.push("# ── CLI tools ──");
    for (const t of m.tools) l.push(`install_tool ${t}`);
    l.push("");
  }
  if (m.env.length) {
    l.push("# ── environment variables this pipeline reads — set these before running ──");
    for (const e of m.env) l.push(`#   export ${e}=...`);
    l.push(`echo "Set before running: ${m.env.join(", ")}"`, "");
  }
  writeFileSync(path, l.join("\n") + "\n");
  chmodSync(path, 0o755);
  return path;
}

/**
 * Render the manifest as a reproducible `reharness/Dockerfile` — the second run path besides `setup.sh`. The
 * image bakes node + reharness + the pipeline's apt tools + npm deps; the pipeline runs INSIDE it (fixed base →
 * no host package-manager variance, no host mutation). Build/run commands are in the header. Assumes `reharness`
 * is installable from npm — for local dev, `npm link reharness` or COPY its build into the image.
 */
export function writeDockerfile(reharnessDir: string, m: Manifest): string {
  const envFlags = m.env.map(e => `-e ${e}`).join(" ");
  // The body is STATIC — all per-pipeline install logic lives in setup.sh (one source for host + container).
  // setup.sh is sudo-aware, so it runs cleanly as root during the build.
  const l: string[] = [
    "# Generated by reharness — reproducible container (the alternative to running setup.sh on the host).",
    "# Build:  docker build -t reharness-pipeline -f reharness/Dockerfile .",
    `# Run:    docker run --rm ${envFlags ? envFlags + " " : ""}reharness-pipeline <command> [args]`,
    "#         (the image is self-contained: code + deps are baked in. To operate on host files, mount them",
    "#          explicitly, e.g. -v \"$PWD/data:/pipeline/data\" — do NOT mount over /pipeline, it hides the build.)",
    "# All install logic is in reharness/setup.sh — one source for both host and container.",
    "# Note: assumes `reharness` is installable from npm; for local dev `npm link reharness` or COPY its build in.",
    "# Note: pipelines with AGENT leaves also need the `pi` agent CLI + its credentials in the image (add a RUN to",
    "#       install it and pass the API key via -e); pure-code (0-agent) pipelines run with nothing more.",
    "",
    "FROM node:20-slim",
    "RUN npm install -g reharness",
    "WORKDIR /pipeline",
    "COPY . .",
    "RUN bash reharness/setup.sh && rm -rf /var/lib/apt/lists/* /root/.npm",
    'ENTRYPOINT ["reharness"]',
  ];
  const path = bundleAt(reharnessDir).dockerfile;
  writeFileSync(path, l.join("\n") + "\n");
  return path;
}

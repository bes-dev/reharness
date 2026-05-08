import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { resolve, relative } from "path";

export interface ScanResult {
  stack: string[];
  manifests: Record<string, string>;
  structure: string[];
  ci: string[];
  tests: string[];
  entryPoints: string[];
}

const MANIFEST_FILES = [
  "package.json", "Cargo.toml", "go.mod", "pyproject.toml",
  "requirements.txt", "Gemfile", "pom.xml", "build.gradle",
  "composer.json", "CMakeLists.txt", "Makefile",
];

const CI_PATTERNS = [
  ".github/workflows", ".gitlab-ci.yml", ".circleci",
  "Jenkinsfile", ".travis.yml", "bitbucket-pipelines.yml",
];

const TEST_PATTERNS = [
  "test", "tests", "spec", "specs", "__tests__",
  "test.ts", "test.js", "spec.ts", "spec.js",
];

export function scanProject(projectDir: string): ScanResult {
  const stack: string[] = [];
  const manifests: Record<string, string> = {};
  const structure: string[] = [];
  const ci: string[] = [];
  const tests: string[] = [];
  const entryPoints: string[] = [];

  // Read manifests
  for (const name of MANIFEST_FILES) {
    const path = resolve(projectDir, name);
    if (existsSync(path)) {
      manifests[name] = readFileSync(path, "utf-8").slice(0, 5000);
      stack.push(detectStackFromManifest(name, manifests[name]));
    }
  }

  // Read tsconfig if exists
  for (const name of ["tsconfig.json", "tsconfig.build.json"]) {
    const path = resolve(projectDir, name);
    if (existsSync(path)) {
      manifests[name] = readFileSync(path, "utf-8").slice(0, 2000);
    }
  }

  // Detect stack from file extensions if manifests didn't help
  if (stack.filter(Boolean).length === 0) {
    const extStack = detectStackFromExtensions(projectDir);
    stack.push(...extStack);
  }

  // Read README if exists
  for (const name of ["README.md", "README.txt", "README.rst", "README"]) {
    const path = resolve(projectDir, name);
    if (existsSync(path)) {
      manifests[name] = readFileSync(path, "utf-8").slice(0, 3000);
      break;
    }
  }

  // Detect CI
  for (const pattern of CI_PATTERNS) {
    const path = resolve(projectDir, pattern);
    if (existsSync(path)) {
      ci.push(pattern);
      if (statSync(path).isDirectory()) {
        readdirSync(path).forEach(f => ci.push(`${pattern}/${f}`));
      }
    }
  }

  // Detect tests
  for (const pattern of TEST_PATTERNS) {
    const path = resolve(projectDir, pattern);
    if (existsSync(path)) tests.push(pattern);
  }

  // Shallow directory listing (max 2 levels)
  structure.push(...listDir(projectDir, projectDir, 0, 2));

  // Detect entry points
  for (const name of ["src/index.ts", "src/main.ts", "src/app.ts", "main.go", "main.py", "src/lib.rs", "index.ts", "index.js", "app.ts", "app.js"]) {
    if (existsSync(resolve(projectDir, name))) entryPoints.push(name);
  }

  return { stack: [...new Set(stack.filter(Boolean))], manifests, structure, ci, tests, entryPoints };
}

export function formatScanReport(projectDir: string, result: ScanResult): string {
  const lines: string[] = ["# Project Scan Report\n"];

  lines.push(`## Stack\n${result.stack.length ? result.stack.join(", ") : "Unknown"}\n`);

  lines.push("## Manifests\n");
  for (const [name, content] of Object.entries(result.manifests)) {
    lines.push(`### ${name}\n\`\`\`\n${content}\n\`\`\`\n`);
  }

  lines.push("## Directory Structure\n```");
  lines.push(result.structure.join("\n"));
  lines.push("```\n");

  if (result.ci.length) lines.push(`## CI/CD\n${result.ci.map(c => `- ${c}`).join("\n")}\n`);
  if (result.tests.length) lines.push(`## Tests\n${result.tests.map(t => `- ${t}`).join("\n")}\n`);
  if (result.entryPoints.length) lines.push(`## Entry Points\n${result.entryPoints.map(e => `- ${e}`).join("\n")}\n`);

  return lines.join("\n");
}

function detectStackFromManifest(name: string, content: string): string {
  if (name === "package.json") {
    const deps = content;
    if (deps.includes("next")) return "Next.js";
    if (deps.includes("expo")) return "Expo/React Native";
    if (deps.includes("react")) return "React";
    if (deps.includes("vue")) return "Vue";
    if (deps.includes("express")) return "Express";
    if (deps.includes("fastify")) return "Fastify";
    return "Node.js";
  }
  if (name === "Cargo.toml") return "Rust";
  if (name === "go.mod") return "Go";
  if (name === "pyproject.toml" || name === "requirements.txt") return "Python";
  if (name === "Gemfile") return "Ruby";
  if (name === "pom.xml" || name === "build.gradle") return "Java/JVM";
  if (name === "composer.json") return "PHP";
  if (name === "CMakeLists.txt") return "C/C++";
  return "";
}

const EXT_TO_STACK: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".rb": "Ruby",
  ".java": "Java", ".kt": "Kotlin", ".scala": "Scala",
  ".cs": "C#", ".fs": "F#",
  ".c": "C", ".cpp": "C++", ".h": "C/C++",
  ".f": "Fortran", ".f90": "Fortran", ".f95": "Fortran", ".for": "Fortran",
  ".swift": "Swift", ".m": "Objective-C",
  ".php": "PHP", ".lua": "Lua", ".zig": "Zig", ".nim": "Nim",
  ".ex": "Elixir", ".erl": "Erlang", ".hs": "Haskell", ".ml": "OCaml",
  ".sh": "Shell", ".bash": "Shell",
};

function detectStackFromExtensions(projectDir: string): string[] {
  const counts: Record<string, number> = {};
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", "__pycache__", "vendor", ".next"]);

  function walk(dir: string, depth: number) {
    if (depth > 3) return;
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".") || SKIP.has(name)) continue;
        const full = resolve(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) { walk(full, depth + 1); continue; }
        const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
        const lang = EXT_TO_STACK[ext];
        if (lang) counts[lang] = (counts[lang] || 0) + 1;
      }
    } catch {}
  }
  walk(projectDir, 0);

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lang]) => lang);
}

function listDir(base: string, dir: string, depth: number, maxDepth: number): string[] {
  if (depth >= maxDepth) return [];
  const entries: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || name === "node_modules" || name === "dist" || name === "build" || name === "target" || name === "__pycache__") continue;
      const full = resolve(dir, name);
      const rel = relative(base, full);
      const stat = statSync(full);
      const indent = "  ".repeat(depth);
      if (stat.isDirectory()) {
        entries.push(`${indent}${name}/`);
        entries.push(...listDir(base, full, depth + 1, maxDepth));
      } else {
        entries.push(`${indent}${name}`);
      }
    }
  } catch {}
  return entries;
}

/**
 * reharness TUI — minimal: full log + statusbar + editor.
 * Log fills available terminal height, terminal handles scrollback.
 */

import {
  ProcessTerminal,
  TUI,
  Editor,
  CombinedAutocompleteProvider,
  truncateToWidth,
  visibleWidth,
  matchesKey,
  isKeyRelease,
  type Component,
  type SlashCommand,
  type EditorTheme,
  type SelectListTheme,
} from "@mariozechner/pi-tui";
import type { Project, CommandDefinition, CommandContext } from "./types.js";
import { formatDuration } from "./ui.js";
import { loadProject } from "./project.js";

// ── ANSI ────────────────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function fitLine(line: string, width: number): string {
  const truncated = truncateToWidth(line, width);
  const pad = Math.max(0, width - visibleWidth(truncated));
  return truncated + " ".repeat(pad);
}

function styleMsg(msg: string): string {
  if (msg.startsWith("✓")) return green(msg);
  if (msg.startsWith("✗")) return red(msg);
  if (msg.startsWith("⚠")) return yellow(msg);
  if (msg.startsWith("  ⏳")) return dim(msg);
  if (msg.startsWith("  ✓")) return green(msg);
  if (msg.startsWith("  ✗")) return red(msg);
  return msg;
}

// ── Step tracking ──────────────────────────────────────────────

type StepStatus = "pending" | "running" | "done" | "failed";
interface StepState { name: string; status: StepStatus; startedAt?: number; elapsed?: string; }
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

class StepTracker {
  steps: StepState[] = [];
  private spinnerFrame = 0;
  private spinnerTimer?: ReturnType<typeof setInterval>;
  private tui: TUI;

  constructor(tui: TUI) { this.tui = tui; }
  get current(): StepState | undefined { return this.steps.find(s => s.status === "running"); }
  get doneCount(): number { return this.steps.filter(s => s.status === "done").length; }
  get total(): number { return this.steps.length; }
  get spinner(): string { return SPINNER[this.spinnerFrame]; }

  setSteps(names: string[]) {
    this.steps = names.map(name => ({ name, status: "pending" as StepStatus }));
    this.startSpinner();
  }

  markRunning(name: string) {
    for (const s of this.steps) {
      if (s.status === "running") {
        s.status = "done";
        if (s.startedAt) s.elapsed = formatDuration(Date.now() - s.startedAt);
      }
    }
    const step = this.steps.find(s => s.name === name);
    if (step) { step.status = "running"; step.startedAt = Date.now(); }
  }

  finish(success: boolean) {
    this.stopSpinner();
    for (const s of this.steps) {
      if (s.status === "running") {
        s.status = success ? "done" : "failed";
        if (s.startedAt) s.elapsed = formatDuration(Date.now() - s.startedAt);
      }
    }
  }

  clear() { this.steps = []; this.stopSpinner(); }

  private startSpinner() {
    this.stopSpinner();
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      this.tui.requestRender();
    }, 80);
  }

  private stopSpinner() {
    if (this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = undefined; }
  }
}

// ── LogView — fills terminal, no line limit ─────────────────────

class LogView implements Component {
  private lines: string[] = [];
  invalidate() {}

  addLine(raw: string) { this.lines.push(styleMsg(raw)); }
  clear() { this.lines = []; }

  render(width: number): string[] {
    if (this.lines.length === 0) return [];
    // Show all lines — let TUI + terminal handle the overflow
    return this.lines.map(l => fitLine(`  ${l}`, width));
  }
}

// ── StatusBar ──────────────────────────────────────────────────

class StatusBar implements Component {
  private tracker: StepTracker;
  private info = "";
  private hint = "";
  private defaultHint = "";

  constructor(tracker: StepTracker) { this.tracker = tracker; }
  setInfo(text: string) { this.info = text; }
  setHint(text: string) { this.hint = text; }
  setDefault(text: string) { this.defaultHint = text; }
  clearHint() { this.hint = ""; }
  clearAll() { this.info = ""; this.hint = ""; }
  invalidate() {}

  render(width: number): string[] {
    const parts: string[] = [];
    const cur = this.tracker.current;
    if (cur) {
      const elapsed = cur.startedAt ? formatDuration(Date.now() - cur.startedAt) : "";
      parts.push(`${cyan(this.tracker.spinner)} ${bold(cur.name)} ${dim(`(${this.tracker.doneCount}/${this.tracker.total})`)} ${dim(elapsed)}`);
    }
    if (this.info) parts.push(dim(this.info));
    if (this.hint) parts.push(this.hint);
    else if (this.defaultHint && parts.length === 0) parts.push(dim(this.defaultHint));
    const text = parts.join(dim("  ·  "));
    return [dim("─".repeat(width)), fitLine(`  ${text}`, width)];
  }
}

// ── Theme ───────────────────────────────────────────────────────

const selectListTheme: SelectListTheme = {
  selectedPrefix: (t) => cyan(t),
  selectedText: (t) => bold(t),
  description: (t) => dim(t),
  scrollInfo: (t) => dim(t),
  noMatch: (t) => dim(t),
};

const editorTheme: EditorTheme = {
  borderColor: (t) => cyan(t),
  selectList: selectListTheme,
};

// ── Helpers ─────────────────────────────────────────────────────

function buildCommandContext(project: Project): CommandContext {
  return { root: project.root, agents: project.agents, cwd: project.root };
}

function buildSlashCommands(project: Project): SlashCommand[] {
  const cmds: SlashCommand[] = [];
  for (const [name, def] of Object.entries(project.commands)) {
    cmds.push({ name, description: def.description, argumentHint: def.usage });
  }
  cmds.push({ name: "help", description: "Show available commands" });
  cmds.push({ name: "quit", description: "Exit reharness" });
  return cmds;
}

function createEmit(tracker: StepTracker, logView: LogView, tui: TUI) {
  return (msg: string) => {
    const stepMatch = msg.match(/^── (\S+) ──$/);
    if (stepMatch) {
      tracker.markRunning(stepMatch[1]);
      tui.requestRender();
      return;
    }
    if (msg.trim()) {
      logView.addLine(msg);
      tui.requestRender();
    }
  };
}

// ── Interactive TUI ─────────────────────────────────────────────

export async function startTui(project: Project, piModel?: string, extraCommands?: Record<string, CommandDefinition>) {
  process.on("SIGINT", () => {});

  let currentProject = project;

  async function reloadProject() {
    const reloaded = await loadProject(currentProject.root, extraCommands);
    if (reloaded) {
      currentProject = reloaded;
      editor.setAutocompleteProvider(
        new CombinedAutocompleteProvider(buildSlashCommands(currentProject), currentProject.root),
      );
    }
  }

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const tracker = new StepTracker(tui);
  const logView = new LogView();
  const statusBar = new StatusBar(tracker);
  const editor = new Editor(tui, editorTheme);

  tui.addChild(logView);
  tui.addChild(statusBar);
  tui.addChild(editor);

  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(buildSlashCommands(currentProject), currentProject.root),
  );

  let running = false;
  let abortController: AbortController | null = null;
  let exitPending = false;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;

  statusBar.setDefault("reharness v0.3.0 · /help · Ctrl+C exit");

  function clearPending() {
    exitPending = false;
    if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
    statusBar.clearHint();
  }

  tui.addInputListener((data) => {
    if (isKeyRelease(data)) return undefined;
    const isEsc = matchesKey(data, "escape");
    const isCtrlC = matchesKey(data, "ctrl+c");

    if (!isEsc && !isCtrlC) {
      if (exitPending) { clearPending(); tui.requestRender(); }
      return undefined;
    }

    if (exitPending) {
      clearPending();
      if (running && abortController) {
        abortController.abort();
        logView.addLine(yellow("⚠ Stopping..."));
        tui.requestRender();
      } else {
        tui.stop();
        process.exit(0);
      }
      return { consume: true };
    }

    exitPending = true;
    statusBar.setHint(running ? "Press again to stop" : "Press again to exit");
    tui.requestRender();
    exitTimer = setTimeout(() => { exitPending = false; statusBar.clearHint(); tui.requestRender(); }, 2000);
    return { consume: true };
  });

  editor.onSubmit = (text) => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    editor.addToHistory(trimmed);

    let input = trimmed;
    if (input.startsWith("/")) input = input.slice(1);

    if (input === "help") { showHelp(logView, currentProject); tui.requestRender(); return; }
    if (input === "quit" || input === "exit") { tui.stop(); process.exit(0); }

    const parts = input.split(/\s+/);
    handleCommand(parts[0], parts.slice(1)).catch(err => {
      logView.addLine(`${red("✗")} ${err.message}`);
      tui.requestRender();
    });
  };

  async function handleCommand(name: string, args: string[]) {
    const def = currentProject.commands[name];
    if (!def) {
      logView.addLine(`${dim("Unknown:")} ${name}`);
      tui.requestRender();
      return;
    }

    const isResume = args.includes("--resume");
    const cleanArgs = args.filter(a => a !== "--resume");
    const cmdCtx = buildCommandContext(currentProject);
    const pipeline = def.run(cleanArgs, cmdCtx);
    if (!pipeline?.run) { logView.addLine(`${red("✗")} "${name}" returned no pipeline`); tui.requestRender(); return; }

    running = true;
    abortController = new AbortController();
    editor.disableSubmit = true;
    tracker.setSteps(Object.keys(pipeline.states));
    logView.clear();
    statusBar.setDefault("Ctrl+C stop");
    tui.requestRender();

    const start = Date.now();
    const emit = createEmit(tracker, logView, tui);
    const onStatus = (text: string) => { statusBar.setInfo(text); tui.requestRender(); };

    try {
      const status = await pipeline.run(emit, { resume: isResume, signal: abortController.signal, onStatus, piModel });
      tracker.finish(status === "success");
      const elapsed = formatDuration(Date.now() - start);
      logView.addLine(status === "success" ? green(`✓ done (${elapsed})`) : red(`✗ ${status} (${elapsed})`));
    } catch (err: any) {
      tracker.finish(false);
      logView.addLine(`${red("✗ crashed:")} ${err.message}`);
    }

    running = false;
    abortController = null;
    editor.disableSubmit = false;
    tracker.clear();
    statusBar.clearAll();
    statusBar.setDefault("reharness v0.3.0 · /help · Ctrl+C exit");
    await reloadProject();
    tui.requestRender();
  }

  tui.setFocus(editor);
  tui.start();
}

// ── Direct (non-interactive) run ────────────────────────────────

export async function runDirect(project: Project, name: string, args: string[], piModel?: string) {
  const def = project.commands[name];
  if (!def) {
    console.error(`Unknown command: ${name}`);
    console.error(`Available: ${Object.keys(project.commands).join(", ")}`);
    process.exit(1);
  }

  const cleanArgs = args.filter(a => a !== "--resume");
  const isResume = args.includes("--resume");
  const cmdCtx = buildCommandContext(project);
  const pipeline = def.run(cleanArgs, cmdCtx);
  if (!pipeline?.run) { console.error(`"${name}" returned no pipeline`); process.exit(1); }

  const tracker = { current: "", done: 0, total: Object.keys(pipeline.states).length };

  const emit = (msg: string) => {
    const stepMatch = msg.match(/^── (\S+) ──$/);
    if (stepMatch) {
      tracker.current = stepMatch[1];
      tracker.done++;
      process.stdout.write(`\r${cyan("⠋")} ${bold(tracker.current)} ${dim(`(${tracker.done}/${tracker.total})`)}\x1b[K`);
      return;
    }
    if (msg.trim()) {
      process.stdout.write("\r\x1b[K");
      console.log(styleMsg(msg));
    }
  };

  const start = Date.now();
  const onStatus = (text: string) => {
    process.stdout.write(`\r${cyan("⠋")} ${bold(tracker.current)} ${dim(text)}\x1b[K`);
  };

  process.on("SIGINT", () => { process.stdout.write("\r\x1b[K"); process.exit(130); });

  try {
    const status = await pipeline.run(emit, { resume: isResume, onStatus, piModel });
    process.stdout.write("\r\x1b[K");
    console.log(status === "success" ? green(`✓ done (${formatDuration(Date.now() - start)})`) : red(`✗ ${status}`));
    process.exit(status === "success" ? 0 : 1);
  } catch (err: any) {
    process.stdout.write("\r\x1b[K");
    console.log(`${red("✗ crashed:")} ${err.message}`);
    process.exit(1);
  }
}

// ── Help ────────────────────────────────────────────────────────

function showHelp(logView: LogView, project: Project) {
  logView.addLine("");
  for (const [name, def] of Object.entries(project.commands)) {
    const usage = def.usage ? ` ${dim(def.usage)}` : "";
    logView.addLine(`${cyan("/" + name.padEnd(14))}${usage}  ${dim(def.description)}`);
  }
  logView.addLine(`${cyan("/help".padEnd(15))} ${dim("Show this help")}`);
  logView.addLine(`${cyan("/quit".padEnd(15))} ${dim("Exit")}`);
  logView.addLine("");
}

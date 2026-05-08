/**
 * reharness TUI — built on @mariozechner/pi-tui.
 *
 * Layout:
 *   Header        "reharness v0.3.0"
 *   PipelineView  step list with status icons + elapsed time
 *   LogView       scrollable log of emit messages
 *   Editor        multiline input with slash-command autocomplete
 */

import {
  ProcessTerminal,
  TUI,
  Editor,
  Text,
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

// ── ANSI helpers ────────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/** Truncate an ANSI string to width and pad with spaces to fill exactly width columns. */
function fitLine(line: string, width: number): string {
  const truncated = truncateToWidth(line, width);
  const pad = Math.max(0, width - visibleWidth(truncated));
  return truncated + " ".repeat(pad);
}

// ── Step status ─────────────────────────────────────────────────

type StepStatus = "pending" | "running" | "done" | "failed";

interface StepState {
  name: string;
  status: StepStatus;
  startedAt?: number;
  elapsed?: string;
}

// ── PipelineView component ──────────────────────────────────────

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

class PipelineView implements Component {
  private steps: StepState[] = [];
  private spinnerFrame = 0;
  private spinnerTimer?: ReturnType<typeof setInterval>;
  private tui: TUI;
  private visible = false;

  constructor(tui: TUI) {
    this.tui = tui;
  }

  setSteps(names: string[]) {
    this.steps = names.map((name) => ({ name, status: "pending" as StepStatus }));
    this.visible = true;
    this.startSpinner();
  }

  markRunning(name: string) {
    for (const s of this.steps) {
      if (s.status === "running") {
        s.status = "done";
        if (s.startedAt) s.elapsed = formatDuration(Date.now() - s.startedAt);
      }
    }
    const step = this.steps.find((s) => s.name === name);
    if (step) {
      step.status = "running";
      step.startedAt = Date.now();
    }
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

  clear() {
    this.steps = [];
    this.visible = false;
    this.stopSpinner();
  }

  private startSpinner() {
    this.stopSpinner();
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      this.tui.requestRender();
    }, 80);
  }

  private stopSpinner() {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  invalidate() {}

  render(width: number): string[] {
    if (!this.visible || this.steps.length === 0) return [];

    const maxName = Math.max(...this.steps.map((s) => s.name.length));
    const lines: string[] = [" ".repeat(width)];

    for (const step of this.steps) {
      const padded = step.name.padEnd(maxName);
      const elapsed = step.elapsed || (step.startedAt ? formatDuration(Date.now() - step.startedAt) : "");
      const timeStr = elapsed ? `  ${dim(elapsed)}` : "";

      let icon: string;
      let label: string;
      switch (step.status) {
        case "done":
          icon = green("✓");
          label = padded;
          break;
        case "failed":
          icon = red("✗");
          label = padded;
          break;
        case "running":
          icon = cyan(SPINNER[this.spinnerFrame]);
          label = bold(padded);
          break;
        default:
          icon = " ";
          label = dim(padded);
          break;
      }

      lines.push(fitLine(`  ${icon} ${label}${timeStr}`, width));
    }

    lines.push(" ".repeat(width));
    return lines;
  }
}

// ── LogView component ───────────────────────────────────────────

class LogView implements Component {
  private lines: string[] = [];
  private maxVisible = 12;

  addLine(raw: string) {
    this.lines.push(this.styleLine(raw));
  }

  clear() {
    this.lines = [];
  }

  invalidate() {}

  private styleLine(msg: string): string {
    if (msg.startsWith("✓")) return `  ${green(msg)}`;
    if (msg.startsWith("✗")) return `  ${red(msg)}`;
    if (msg.startsWith("⚠")) return `  ${yellow(msg)}`;
    if (msg.startsWith("  ⏳") || msg.startsWith("  ✓")) return `  ${dim(msg)}`;
    if (msg.startsWith("BUILD COMPLETE") || msg.startsWith("IMPROVE COMPLETE")) return `  ${bold(green(msg))}`;
    if (msg.startsWith("  cd apps/")) return `  ${dim(msg)}`;
    return `  ${msg}`;
  }

  render(width: number): string[] {
    if (this.lines.length === 0) return [];
    return this.lines.slice(-this.maxVisible).map((l) => fitLine(l, width));
  }
}

// ── StatusLine component ────────────────────────────────────────

class StatusLine implements Component {
  private text = "";

  setText(text: string) {
    this.text = text;
  }

  invalidate() {}

  render(width: number): string[] {
    if (!this.text) return [" ".repeat(width)];
    return [
      " ".repeat(width),
      dim("─".repeat(width)),
      fitLine(` ${dim(this.text)}`, width),
      " ".repeat(width),
    ];
  }
}

// ── HintBar component ───────────────────────────────────────────

class HintBar implements Component {
  private pipelineStatus = "";
  private hint = "";
  private defaultHint = "";

  /** Persistent status from pipeline (ctx.status). */
  setStatus(text: string) {
    this.pipelineStatus = text;
  }

  /** Temporary hint (key press feedback, disappears on next action). */
  setHint(text: string) {
    this.hint = text;
  }

  /** Default hint shown when nothing else is active. */
  setDefault(text: string) {
    this.defaultHint = text;
  }

  clearHint() {
    this.hint = "";
  }

  clearAll() {
    this.pipelineStatus = "";
    this.hint = "";
  }

  invalidate() {}

  render(width: number): string[] {
    const parts: string[] = [];
    if (this.pipelineStatus) parts.push(this.pipelineStatus);
    if (this.hint) parts.push(this.hint);
    else if (this.defaultHint && !this.pipelineStatus) parts.push(this.defaultHint);

    if (parts.length === 0) return [];
    const text = parts.join(dim("  ·  "));
    return [fitLine(` ${dim(text)}`, width)];
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

// ── Shared helpers ──────────────────────────────────────────────

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

function createEmit(pipelineView: PipelineView, logView: LogView, tui: TUI) {
  return (msg: string) => {
    const stepMatch = msg.match(/^── (\S+) ──$/);
    if (stepMatch) {
      pipelineView.markRunning(stepMatch[1]);
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
  // Prevent default SIGINT handler — we handle Ctrl+C ourselves
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
  let cmdCtx = buildCommandContext(currentProject);

  const header = new Text(`${bold("reharness")} ${dim("v0.3.0")}`, 1, 0);
  const pipelineView = new PipelineView(tui);
  const logView = new LogView();
  const statusLine = new StatusLine();
  const editor = new Editor(tui, editorTheme);
  const hintBar = new HintBar();

  tui.addChild(header);
  tui.addChild(pipelineView);
  tui.addChild(logView);
  tui.addChild(statusLine);
  tui.addChild(editor);
  tui.addChild(hintBar);

  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(buildSlashCommands(currentProject), currentProject.root),
  );

  let running = false;
  let abortController: AbortController | null = null;
  let exitPending = false;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;

  hintBar.setDefault("Ctrl+C to exit · /help for commands · Tab to autocomplete");

  function clearPending() {
    exitPending = false;
    if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
    hintBar.clearHint();
  }

  function startPendingTimer() {
    if (exitTimer) clearTimeout(exitTimer);
    exitTimer = setTimeout(() => {
      exitPending = false;
      hintBar.clearHint();
      tui.requestRender();
    }, 2000);
  }

  tui.addInputListener((data) => {
    if (isKeyRelease(data)) return undefined;

    const isEsc = matchesKey(data, "escape");
    const isCtrlC = matchesKey(data, "ctrl+c");

    if (!isEsc && !isCtrlC) {
      if (exitPending) { clearPending(); tui.requestRender(); }
      return undefined;
    }

    // Second press — execute
    if (exitPending) {
      clearPending();
      if (running && abortController) {
        abortController.abort();
        logView.addLine(yellow("⚠ Stopping pipeline..."));
        tui.requestRender();
      } else {
        tui.stop();
        process.exit(0);
      }
      return { consume: true };
    }

    // First press — show hint
    exitPending = true;
    hintBar.setHint(running ? "Press again to stop pipeline" : "Press again to exit");
    tui.requestRender();
    startPendingTimer();
    return { consume: true };
  });

  editor.onSubmit = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (running) return;
    editor.addToHistory(trimmed);

    let input = trimmed;
    if (input.startsWith("/")) input = input.slice(1);

    if (input === "help") {
      showHelp(logView, currentProject);
      tui.requestRender();
      return;
    }
    if (input === "quit" || input === "exit") {
      tui.stop();
      process.exit(0);
    }

    const parts = input.split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);
    if (!command) return;

    handleCommand(command, args).catch((err) => {
      logView.addLine(`${red("✗")} ${err.message}`);
      tui.requestRender();
    });
  };

  async function handleCommand(name: string, args: string[]) {
    const def = currentProject.commands[name];
    if (!def) {
      logView.addLine(`${dim("Unknown command:")} ${name}`);
      tui.requestRender();
      return;
    }

    const isResume = args.includes("--resume");
    const cleanArgs = args.filter(a => a !== "--resume");

    cmdCtx = buildCommandContext(currentProject);
    const pipeline = def.run(cleanArgs, cmdCtx);
    if (!pipeline?.run) {
      logView.addLine(`${red("✗")} Command "${name}" did not return a pipeline`);
      tui.requestRender();
      return;
    }

    running = true;
    abortController = new AbortController();
    editor.disableSubmit = true;
    pipelineView.setSteps(Object.keys(pipeline.states));
    logView.clear();
    hintBar.setDefault("Esc/Ctrl+C to stop pipeline");
    statusLine.setText(`Running: /${name} ${cleanArgs.join(" ")}${isResume ? " (resume)" : ""}`);
    tui.requestRender();

    const start = Date.now();
    const emit = createEmit(pipelineView, logView, tui);
    const onStatus = (text: string) => {
      hintBar.setStatus(text);
      tui.requestRender();
    };

    try {
      const status = await pipeline.run(emit, { resume: isResume, signal: abortController.signal, onStatus, piModel });
      pipelineView.finish(status === "success");
      const elapsed = formatDuration(Date.now() - start);
      const result = status === "success" ? green(`✓ ${status}`) : red(`✗ ${status}`);
      statusLine.setText(`/${name} — ${result} ${dim(`(${elapsed})`)}`);
    } catch (err: any) {
      pipelineView.finish(false);
      statusLine.setText(`/${name} — ${red("crashed")}: ${err.message}`);
    }

    running = false;
    abortController = null;
    editor.disableSubmit = false;
    hintBar.clearAll();
    hintBar.setDefault("Ctrl+C to exit · /help for commands · Tab to autocomplete");

    // Reload project to pick up newly generated commands
    await reloadProject();

    tui.requestRender();
  }

  tui.setFocus(editor);
  tui.start();
}

// ── Direct (non-interactive) run ────────────────────────────────

export async function runDirect(project: Project, name: string, args: string[], piModel?: string) {
  process.on("SIGINT", () => {});
  const isResume = args.includes("--resume");
  const cleanArgs = args.filter(a => a !== "--resume");

  const def = project.commands[name];
  if (!def) {
    console.error(`Unknown command: ${name}`);
    console.error(`Available: ${Object.keys(project.commands).join(", ")}`);
    process.exit(1);
  }

  const cmdCtx = buildCommandContext(project);
  const pipeline = def.run(cleanArgs, cmdCtx);
  if (!pipeline?.run) {
    console.error(`Command "${name}" did not return a pipeline`);
    process.exit(1);
  }

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const pipelineView = new PipelineView(tui);
  const logView = new LogView();
  const statusLine = new StatusLine();

  tui.addChild(new Text(`${bold("reharness")} ${dim(`/${name}`)} ${dim(cleanArgs.join(" "))}`, 1, 0));
  tui.addChild(pipelineView);
  tui.addChild(logView);
  tui.addChild(statusLine);

  const ac = new AbortController();
  const hintBar = new HintBar();
  tui.addChild(hintBar);

  tui.addInputListener((data) => {
    if (isKeyRelease(data)) return undefined;
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
      if (!ac.signal.aborted) {
        ac.abort();
        hintBar.setHint("Aborting... press again to force exit");
        tui.requestRender();
        return { consume: true };
      }
      tui.stop();
      process.exit(130);
    }
    return undefined;
  });

  pipelineView.setSteps(Object.keys(pipeline.states));
  hintBar.setDefault("Esc/Ctrl+C to stop");
  statusLine.setText(`Running: /${name}${isResume ? " (resume)" : ""}`);
  tui.start();

  const start = Date.now();
  const emit = createEmit(pipelineView, logView, tui);
  const onStatus = (text: string) => { hintBar.setStatus(text); tui.requestRender(); };

  try {
    const status = await pipeline.run(emit, { resume: isResume, signal: ac.signal, onStatus, piModel });
    pipelineView.finish(status === "success");
    statusLine.setText(`/${name} — ${status === "success" ? green("done") : red(status)} (${formatDuration(Date.now() - start)})`);
    tui.requestRender();
    await new Promise((r) => setTimeout(r, 500));
    tui.stop();
    process.exit(status === "success" ? 0 : 1);
  } catch (err: any) {
    pipelineView.finish(false);
    statusLine.setText(`/${name} — ${red("crashed")}: ${err.message}`);
    tui.requestRender();
    await new Promise((r) => setTimeout(r, 500));
    tui.stop();
    process.exit(1);
  }
}

// ── Help ────────────────────────────────────────────────────────

function showHelp(logView: LogView, project: Project) {
  logView.addLine("");
  for (const [name, def] of Object.entries(project.commands)) {
    const usage = def.usage ? ` ${dim(def.usage)}` : "";
    logView.addLine(`${cyan("/" + name.padEnd(12))}${usage}  ${dim(def.description)}`);
  }
  logView.addLine(`${cyan("/help".padEnd(13))} ${dim("Show this help")}`);
  logView.addLine(`${cyan("/quit".padEnd(13))} ${dim("Exit")}`);
  logView.addLine("");
}

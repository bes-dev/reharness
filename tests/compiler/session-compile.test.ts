import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { buildGeneratePipeline, recoverPrd } from "../../src/compiler/generate.js";
import { readSessionInput } from "../../src/compiler/runner.js";

const ctx = (config: any, data: any = {}): any => ({ config, data, emit: () => {}, retries: () => 0, retry: () => {}, dirs: () => [], dir: () => "" });
const gen = (dir: string) => { mkdirSync(resolve(dir, "reharness/.cache/scratch"), { recursive: true }); return buildGeneratePipeline({ cwd: dir, input: "" }); };
const tmp = () => mkdtempSync(resolve(tmpdir(), "rh-sc-"));

test("session front: the start switch routes to load_session when config.session", () => {
  const dir = tmp();
  try {
    const p = gen(dir);
    const branch = (p.states as any).start.branches.find((b: any) => b.guard(ctx({ session: true })));
    assert.equal(branch.target, "load_session");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("load_session: a small session routes GROUND (→ the unified research) and reads it directly", async () => {
  const dir = tmp();
  try {
    const p = gen(dir);
    writeFileSync(resolve(dir, "reharness/.cache/scratch/session.md"), "user: review PR 7\nassistant: done");
    const c = ctx({ session: true });
    assert.equal(await (p.states as any).load_session.entry(c), "GROUND");
    assert.equal((p.states as any).load_session.on.GROUND, "maybe_research"); // both fronts converge on one research
    assert.match(c.data.sessionDoc, /session\.md$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("one evidence-adaptive research grounds both fronts; maybe_distill routes session→distill, request→prd", () => {
  const dir = tmp();
  try {
    const p = gen(dir) as any;
    const pick = (branches: any[], c: any) => branches.find((b) => !b.guard || b.guard(c)).target; // runtime switch semantics
    assert.ok(!p.states.research_session, "research_session is merged into the single research agent");
    assert.equal(p.states.merge_digest.on.DONE, "maybe_research");   // large-session path grounds via the same research
    assert.equal(p.states.research.on, "maybe_distill");             // research → the front router
    assert.equal(pick(p.states.maybe_distill.branches, ctx({ session: true })), "distill");
    assert.equal(pick(p.states.maybe_distill.branches, ctx({})), "prd");
    // --fast skips grounding straight to the router (symmetric on both fronts)
    assert.equal(pick(p.states.maybe_research.branches, ctx({ fast: true })), "maybe_distill");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("load_session: an empty session errors", async () => {
  const dir = tmp();
  try {
    const p = gen(dir);
    writeFileSync(resolve(dir, "reharness/.cache/scratch/session.md"), "   \n  ");
    assert.equal(await (p.states as any).load_session.entry(ctx({ session: true })), "ERROR");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("load_session: a large session routes CONDENSE + chunks; merge_digest reduces the digests", async () => {
  const dir = tmp();
  try {
    const p = gen(dir);
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i} ` + "x".repeat(60)).join("\n"); // ~136k chars > 80k
    writeFileSync(resolve(dir, "reharness/.cache/scratch/session.md"), big);
    const c = ctx({ session: true });
    assert.equal(await (p.states as any).load_session.entry(c), "CONDENSE");
    assert.ok(Array.isArray(c.data.chunks) && c.data.chunks.length > 1, "split into multiple chunks");
    assert.ok(existsSync(resolve(dir, "reharness/.cache/scratch/session-chunks/chunk-0.md")));

    // simulate the per-chunk condense agents writing digest.md to their own branch output dirs, then reduce via c.dirs
    const branchDirs = (c.data.chunks as number[]).map(i => { const bd = resolve(dir, `branch-${i}`); mkdirSync(bd, { recursive: true }); writeFileSync(resolve(bd, "digest.md"), `digest ${i}`); return bd; });
    const mc = ctx({ session: true }, c.data); mc.dirs = (stage: string) => stage === "condense_chunk" ? branchDirs : [];
    assert.equal(await (p.states as any).merge_digest.entry(mc), "DONE");
    const merged = readFileSync(resolve(dir, "reharness/.cache/scratch/session-digest.md"), "utf-8");
    assert.match(merged, /digest 0/);
    assert.match(merged, new RegExp(`digest ${branchDirs.length - 1}`));
    assert.match(mc.data.sessionDoc, /session-digest\.md$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recoverPrd: recovers prd.md from the agent's OWN output dir to the canonical path", () => {
  const dir = tmp();
  try {
    const out = resolve(dir, "out"); mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "prd.md"), "# PRD distilled from a session"); // agent wrote into its own out dir
    const c = ctx({ session: true }); c.out = () => out;
    assert.equal(recoverPrd(dir, c), true);
    assert.match(readFileSync(resolve(dir, "reharness/.cache/scratch/prd.md"), "utf-8"), /distilled from a session/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recoverPrd: a PRD already at the canonical path is kept (idempotent); false when none exists anywhere", () => {
  const dir = tmp();
  try {
    mkdirSync(resolve(dir, "reharness/.cache/scratch"), { recursive: true });
    writeFileSync(resolve(dir, "reharness/.cache/scratch/prd.md"), "# durable PRD");
    const c = ctx({ session: true }); c.out = () => resolve(dir, "empty"); // nothing to recover from
    assert.equal(recoverPrd(dir, c), true);
    assert.match(readFileSync(resolve(dir, "reharness/.cache/scratch/prd.md"), "utf-8"), /durable PRD/);
    rmSync(resolve(dir, "reharness/.cache/scratch/prd.md"));
    assert.equal(recoverPrd(dir, c), false); // nothing anywhere
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readSessionInput: a file is read verbatim; a dir concatenates text files with path headers", () => {
  const dir = tmp();
  try {
    writeFileSync(resolve(dir, "a.jsonl"), '{"role":"user","content":"hi"}');
    assert.equal(readSessionInput(resolve(dir, "a.jsonl")), '{"role":"user","content":"hi"}'); // format-agnostic: raw bytes
    const sub = resolve(dir, "sess"); mkdirSync(sub);
    writeFileSync(resolve(sub, "1.md"), "one"); writeFileSync(resolve(sub, "2.md"), "two");
    const all = readSessionInput(sub);
    assert.match(all, /===== 1\.md =====\none/);
    assert.match(all, /===== 2\.md =====\ntwo/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

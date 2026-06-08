import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../../src/runtime/redact.js";

test("redact: masks credentials in a URL, keeps the rest of the command", () => {
  const out = redact("git clone https://alice:ghp_abcd1234ABCD5678efgh9012ijkl3456@github.com/x/y.git");
  assert.ok(!out.includes("ghp_abcd1234ABCD5678efgh9012ijkl3456"), out);
  assert.ok(out.includes("github.com/x/y.git"), "non-secret path preserved");
  assert.ok(out.includes("«redacted»"));
});

test("redact: masks Authorization headers and provider token prefixes", () => {
  assert.ok(!redact("Authorization: Bearer sk-proj-ABCDEFGH12345678abcdefgh").includes("ABCDEFGH12345678"));
  assert.ok(!redact("key=sk-ABCDEFGHIJKLMNOP12345678").includes("ABCDEFGHIJKLMNOP"));
  assert.ok(!redact("token ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345").includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
  assert.ok(!redact("aws AKIAIOSFODNN7EXAMPLE here").includes("AKIAIOSFODNN7EXAMPLE"));
});

test("redact: masks explicit secret assignments, preserving the key", () => {
  const out = redact(`{"api_key":"abcdef123456","name":"hello"}`);
  assert.ok(!out.includes("abcdef123456"), out);
  assert.ok(out.includes("api_key"), "the key name stays (only the value is masked)");
  assert.ok(out.includes("hello"), "non-secret field untouched");
});

test("redact: leaves ordinary text, ids and hashes untouched", () => {
  const s = "Resuming from review (run 2026-06-08T09-49-33); commit a1b2c3d; 1234 tokens · $0.12";
  assert.equal(redact(s), s);
});

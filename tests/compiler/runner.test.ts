import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeCommandName } from "../../src/compiler/runner.js";

test("sanitizeCommandName: kebab-cases valid names, rejects unusable ones", () => {
  assert.equal(sanitizeCommandName("My Cool Workflow"), "my-cool-workflow");
  assert.equal(sanitizeCommandName("github_issue_gen"), "github-issue-gen");
  assert.equal(sanitizeCommandName("  Report-PDF  "), "report-pdf");
  assert.equal(sanitizeCommandName("pdf📄gen"), "pdf-gen");      // non-ascii collapses to a separator
  assert.equal(sanitizeCommandName("123abc"), null);             // a skeleton id must start with a letter
  assert.equal(sanitizeCommandName("  --  "), null);             // nothing usable left
  assert.equal(sanitizeCommandName(""), null);
});

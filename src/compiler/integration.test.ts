import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parseSkeletonXML } from "./xml.js";
import { emitCommand } from "./codegen.js";
import { validateSkeleton, configFlowErrors } from "./analysis/index.js";

/** End-to-end on the real nitpicker_v11 artifact (if present): the skeleton validates, config-flow is clean,
 *  and the regenerated command parses CLI flags into config (the #1 regression guard). */
const SK = resolve(import.meta.dirname, "../../examples/nitpicker_v11/.reharness/skeletons/nitpicker.xml");
const LIB = resolve(import.meta.dirname, "../../examples/nitpicker_v11/.reharness/lib/nitpicker-states.ts");

test("nitpicker_v11 skeleton validates + config-flow clean + parser emitted", { skip: !existsSync(SK) }, () => {
  const sk = parseSkeletonXML(readFileSync(SK, "utf8"));
  assert.deepEqual(validateSkeleton(sk), []);
  const lib = existsSync(LIB) ? readFileSync(LIB, "utf8") : undefined;
  assert.deepEqual(configFlowErrors(sk, lib), []);

  const cmd = emitCommand(sk, Object.entries(sk.states).filter(([, s]) => s.type === "code").map(([n]) => n));
  assert.match(cmd, /const flags/);
  assert.match(cmd, /config\["models"\]/);
  assert.match(cmd, /split\(','\)/);
});

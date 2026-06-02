import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkeletonXML, serializeSkeletonXML } from "./xml.js";
import { emitCommand } from "./codegen.js";
import type { Skeleton } from "./schema.js";

const SK = (harness: string) => `<skeleton id="h" initial="a"><description>d</description><usage>u</usage>
 <state name="a" type="agent">
   ${harness}
   <contract><![CDATA[do thing]]></contract>
   <on event="DONE" target="done"/>
 </state>
 <state name="done" type="final" status="success"/></skeleton>`;

test("parses <harness> attributes", () => {
  const sk = parseSkeletonXML(SK(`<harness model="anthropic/claude-opus-4-8" thinking="high" context-files="off" />`));
  assert.deepEqual(sk.states.a.harness, {
    model: "anthropic/claude-opus-4-8", thinking: "high", contextFiles: false,
  });
});

test("no <harness> ⇒ undefined (backward compatible)", () => {
  const sk = parseSkeletonXML(SK(``));
  assert.equal(sk.states.a.harness, undefined);
});

test("round-trips <harness>", () => {
  const sk = parseSkeletonXML(SK(`<harness model="sonnet" thinking="low" context-files="off" />`));
  const sk2 = parseSkeletonXML(serializeSkeletonXML(sk));
  assert.deepEqual(sk2.states.a.harness, sk.states.a.harness);
});

test("codegen emits harness opts (thinking + model + noContextFiles)", () => {
  const sk = parseSkeletonXML(SK(`<harness model="sonnet" thinking="high" context-files="off" />`));
  const cmd = emitCommand(sk, []);
  assert.match(cmd, /thinking: "high"/);
  assert.match(cmd, /noContextFiles: true/);
  assert.match(cmd, /"sonnet"/);           // harness model lands as the model fallback
});

test("no harness ⇒ no harness opts emitted (regression guard)", () => {
  const sk = parseSkeletonXML(SK(``));
  const cmd = emitCommand(sk, []);
  assert.doesNotMatch(cmd, /thinking:/);
  assert.doesNotMatch(cmd, /noContextFiles/);
});

test("model-expr takes precedence over harness model", () => {
  const sk: Skeleton = {
    id: "h", description: "d", usage: "u", initial: "a",
    states: {
      a: { type: "agent", contract: "x", modelExpr: "config.m", harness: { model: "sonnet" },
           on: { DONE: "done" } },
      done: { type: "final", status: "success" },
    },
  };
  const cmd = emitCommand(sk, []);
  // dynamic model (c.config.m) is tried first, harness model is the ?? fallback
  assert.match(cmd, /c\.config\.m \?\? "sonnet"/);
});

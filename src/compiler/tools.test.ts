import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkeletonXML, serializeSkeletonXML } from "./xml.js";
import { emitCommand, emitToolExtension } from "./codegen.js";

const SK = (tools: string) => `<skeleton id="t" initial="a"><description>d</description><usage>u</usage>
 <state name="a" type="agent">
   ${tools}
   <contract><![CDATA[do thing]]></contract>
   <on event="DONE" target="done"/>
 </state>
 <state name="done" type="final" status="success"/></skeleton>`;

const TOOLS = `<tools>
  <tool name="parse_xlsx" effect="ReadWorkspace"><spec><![CDATA[Input {path}. Parse xlsx → {sheets}. Pure.]]></spec></tool>
  <tool name="tally" />
</tools>`;

test("parses <tools> into ToolDecl[]", () => {
  const sk = parseSkeletonXML(SK(TOOLS));
  assert.deepEqual(sk.states.a.tools, [
    { name: "parse_xlsx", effect: "ReadWorkspace", spec: "Input {path}. Parse xlsx → {sheets}. Pure." },
    { name: "tally" },
  ]);
});

test("no <tools> ⇒ undefined (backward compatible)", () => {
  assert.equal(parseSkeletonXML(SK(``)).states.a.tools, undefined);
});

test("round-trips <tools>", () => {
  const sk = parseSkeletonXML(SK(TOOLS));
  const sk2 = parseSkeletonXML(serializeSkeletonXML(sk));
  assert.deepEqual(sk2.states.a.tools, sk.states.a.tools);
});

test("codegen wires the generated extension into the agent's opts", () => {
  const sk = parseSkeletonXML(SK(TOOLS));
  const cmd = emitCommand(sk, []);
  assert.match(cmd, /extensions: \[resolve\(ctx\.agents, '\.\.', 'tools', "a-tools\.ts"\)\]/);
});

test("no tools ⇒ no extensions opt (regression guard)", () => {
  const cmd = emitCommand(parseSkeletonXML(SK(``)), []);
  assert.doesNotMatch(cmd, /extensions:/);
});

test("emitToolExtension registers each tool, with stub bodies + spec comment", () => {
  const ext = emitToolExtension("a", [
    { name: "parse_xlsx", effect: "ReadWorkspace", spec: "Input {path}. Parse." },
    { name: "tally" },
  ]);
  assert.match(ext, /export default function install\(pi: ExtensionAPI\)/);
  assert.match(ext, /name: "parse_xlsx"/);
  assert.match(ext, /name: "tally"/);
  assert.match(ext, /\/\/ TODO: implement parse_xlsx/);
  assert.match(ext, /effect: ReadWorkspace/);
  assert.match(ext, /\/\/ SPEC:/);
  assert.match(ext, /registerTool/);
});

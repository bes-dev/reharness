import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { createServer } from "net";
import { request } from "http";
import { definePipeline } from "../../src/runtime/fsm.js";

const silent = () => {};

/** Grab an ephemeral free port (open on :0, reuse the assigned number). */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

/** POST a body, retrying until the run's webhook server is listening (run() opens it asynchronously). */
async function post(port: number, path: string, body: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise<boolean>((res) => {
      const req = request({ host: "127.0.0.1", port, path, method: "POST" }, (r) => { r.resume(); r.on("end", () => res(true)); });
      req.on("error", () => res(false));
      req.end(body);
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("webhook never came up");
}

test("wait/webhook: a POST resolves DONE and captures the body; the timeout does not fire (timer cleared on settle)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-wh-"));
  const port = await freePort();
  let captured: string | undefined;
  try {
    const pipe = definePipeline({
      config: { target: dir },
      cwd: dir,
      logsDir: resolve(dir, "logs"),
      initial: "hook",
      states: {
        // A 10s timeout that must NOT fire — the request settles DONE first and clears the timer.
        hook: { type: "wait", mode: "webhook", port, path: "/cb", timeoutMs: 10_000, on: { DONE: "after", TIMEOUT: "timedout" } },
        after: { entry: async (c) => { captured = c.data.webhookBody; return "DONE"; }, on: { DONE: "done" } },
        done: { type: "final", status: "success" },
        timedout: { type: "final", status: "error" }, // a fired timeout would route here → test fails
      },
    });
    const started = Date.now();
    const run = pipe.run(silent, { autoApprove: true });
    await post(port, "/cb", "hello");
    const status = await run;
    assert.equal(status, "success");          // routed via DONE (not the TIMEOUT terminal)
    assert.equal(captured, "hello");          // body captured from the request
    assert.ok(Date.now() - started < 9_000, "resolved via DONE well before the 10s timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

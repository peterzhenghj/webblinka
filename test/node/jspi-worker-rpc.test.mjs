// Proves the load-bearing assumption of webblinka's architecture: synchronous
// Python running inside a worker can call out to the main thread over
// postMessage and resume, because JSPI suspension hands control back to *that
// thread's* event loop, which is what delivers the reply.
//
// If this ever fails, the whole design (Pyodide in a worker, WebHID on the main
// thread) has to be rethought -- so it is the first test in the suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./fixtures/jspi-worker.mjs", import.meta.url));

test("JSPI supported by this Node build", () => {
  assert.equal(
    typeof WebAssembly.Suspending,
    "function",
    "Node is too old for unflagged JSPI -- see .nvmrc",
  );
});

test("run_sync in a worker resumes on a postMessage reply", async () => {
  const worker = new Worker(WORKER);
  try {
    // The worker answers each request by echoing the command byte back, so a
    // correct round-trip is visible in the payload rather than just "no hang".
    const result = await new Promise((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", (msg) => {
        if (msg.kind === "hid") {
          // Stand in for the main thread's WebHID transport.
          worker.postMessage({ kind: "hidResult", id: msg.id, data: [msg.command, 0x00, 0x42] });
        } else if (msg.kind === "done") {
          resolve(msg);
        } else if (msg.kind === "failed") {
          reject(new Error(msg.error));
        }
      });
    });

    assert.deepEqual(result.transfers, [
      [0x10, 0x00, 0x42],
      [0x51, 0x00, 0x42],
      [0x10, 0x00, 0x42],
    ]);
    assert.ok(result.sleptMs >= 20, `patched time.sleep should really wait, got ${result.sleptMs}ms`);
  } finally {
    await worker.terminate();
  }
});

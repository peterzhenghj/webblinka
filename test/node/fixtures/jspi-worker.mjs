// Worker half of jspi-worker-rpc.test.mjs. Mirrors src/worker/pyworker.ts as
// closely as a fixture can: Pyodide in a worker, a promise-returning bridge on
// globalThis, and synchronous Python calling it through run_sync.

import { parentPort } from "node:worker_threads";
import { loadPyodide } from "pyodide";

const pending = new Map();
let nextId = 1;

parentPort.on("message", (msg) => {
  if (msg.kind === "hidResult") {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve?.(msg.data);
  }
});

globalThis.webblinkaHid = {
  xfer(command) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      parentPort.postMessage({ kind: "hid", id, command });
    });
  },
  sleep(seconds) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  },
};

const PYTHON = `
import js, time
from pyodide.ffi import run_sync

# The real worker patches time.sleep the same way, so a sleep inside Blinka's
# retry loops yields to the event loop instead of busy-waiting and starving the
# message handler that delivers HID replies.
def _sleep(seconds):
    run_sync(js.webblinkaHid.sleep(seconds))

time.sleep = _sleep


def hid_xfer(command):
    """Synchronous, exactly like Blinka's MCP2221._hid_xfer."""
    return list(run_sync(js.webblinkaHid.xfer(command)).to_py())


def deep_a(command):
    return deep_b(command)


def deep_b(command):
    time.sleep(0.01)
    return hid_xfer(command)


started = time.monotonic()
transfers = [deep_a(0x10), deep_a(0x51), deep_a(0x10)]
elapsed_ms = (time.monotonic() - started) * 1000
[transfers, elapsed_ms]
`;

try {
  const py = await loadPyodide();
  const out = await py.runPythonAsync(PYTHON);
  const [transfers, sleptMs] = out.toJs({ create_pyproxies: false });
  parentPort.postMessage({ kind: "done", transfers, sleptMs });
} catch (err) {
  parentPort.postMessage({ kind: "failed", error: String(err) });
}

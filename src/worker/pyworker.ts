/// <reference lib="webworker" />
import type { Report } from "../hid/transport.ts";
import { PY_ROOT, bootstrapSource } from "./bootstrap.ts";
import type { FromWorker, HidRequest, HidResponse, ToWorker } from "./protocol.ts";

/**
 * Pyodide lives here, off the main thread, so a runaway driver loop can never
 * freeze the page. It has no access to navigator.hid -- requestDevice() needs a
 * user gesture on the main thread -- so python/hid.py calls the bridge installed
 * on globalThis below, which round-trips each 64-byte report over postMessage.
 * JSPI makes that asynchronous hop invisible to Blinka's synchronous code.
 */

// Bundled at build time so the Python sources stay real, lintable files on disk
// instead of string literals wedged inside TypeScript.
const PY_SOURCES = import.meta.glob("../../python/**/*.py", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface PyodideLike {
  version: string;
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  loadPackage(names: string | string[]): Promise<unknown>;
  pyimport(name: string): PyProxyLike;
  setStdout(opts: { batched: (s: string) => void }): void;
  setStderr(opts: { batched: (s: string) => void }): void;
  FS: { mkdirTree(path: string): void; writeFile(path: string, data: string): void };
}

interface PyProxyLike {
  callPromising(...args: unknown[]): Promise<unknown>;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer);
}

// ---------------------------------------------------------------- HID bridge

const pendingHid = new Map<number, { resolve: (v: HidResponse) => void; reject: (e: Error) => void }>();
let nextHidId = 1;

function hidCall(request: HidRequest): Promise<HidResponse> {
  const id = nextHidId++;
  return new Promise((resolve, reject) => {
    pendingHid.set(id, { resolve, reject });
    const transfer = request.op === "write" ? [request.data.buffer] : [];
    post({ kind: "hid", id, request }, transfer as Transferable[]);
  });
}

Object.assign(globalThis, {
  webblinkaHid: {
    enumerate: () => hidCall({ op: "enumerate" }),
    open: (vendorId: number, productId: number) => hidCall({ op: "open", vendorId, productId }),
    write: (data: Report) => hidCall({ op: "write", data }),
    read: (length: number, timeoutMs: number) => hidCall({ op: "read", length, timeoutMs }),
    close: () => hidCall({ op: "close" }),
  },
  webblinkaSleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
});

// --------------------------------------------------------------------- boot

let dispatch: PyProxyLike | null = null;

async function boot(pyodideIndexUrl: string, wheelUrls: string[]): Promise<void> {
  post({ kind: "status", phase: "loading-runtime" });
  const { loadPyodide } = (await import(
    /* @vite-ignore */ `${pyodideIndexUrl}pyodide.mjs`
  )) as { loadPyodide: (o: { indexURL: string }) => Promise<PyodideLike> };

  const py = await loadPyodide({ indexURL: pyodideIndexUrl });
  py.setStdout({ batched: (text) => post({ kind: "log", stream: "stdout", text }) });
  py.setStderr({ batched: (text) => post({ kind: "log", stream: "stderr", text }) });

  post({ kind: "status", phase: "installing-packages" });
  await py.loadPackage("micropip");
  const micropip = py.pyimport("micropip") as unknown as {
    install(urls: string[], opts: { deps: boolean }): Promise<void>;
  };
  // deps:false because scripts/fetch_wheels.py already vendors the full closure;
  // resolving would send micropip to PyPI for wheels we are serving ourselves.
  await micropip.install(wheelUrls, { deps: false });

  post({ kind: "status", phase: "starting-blinka" });
  writePythonSources(py);
  await py.runPythonAsync(bootstrapSource());
  const rpc = py.pyimport("webblinka.rpc") as unknown as { dispatch: PyProxyLike };
  dispatch = rpc.dispatch;

  const pythonVersion = py.runPython("import sys; sys.version.split()[0]") as string;
  post({ kind: "ready", pyodideVersion: py.version, pythonVersion });
}

function writePythonSources(py: PyodideLike): void {
  for (const [key, source] of Object.entries(PY_SOURCES)) {
    const rel = key.slice(key.indexOf("/python/") + "/python/".length);
    const path = `${PY_ROOT}/${rel}`;
    const dir = path.slice(0, path.lastIndexOf("/"));
    py.FS.mkdirTree(dir);
    py.FS.writeFile(path, source);
  }
}

// ------------------------------------------------------------------ dispatch

async function call(id: number, fn: string, args: unknown[]): Promise<void> {
  if (!dispatch) {
    post({ kind: "reply", id, ok: false, error: "Python runtime is not ready" });
    return;
  }
  try {
    // callPromising enables stack switching, which is what lets the Python
    // underneath use run_sync to block on a HID round-trip.
    const json = (await dispatch.callPromising(fn, JSON.stringify(args))) as string;
    post({ kind: "reply", id, ok: true, value: JSON.parse(json) });
  } catch (err) {
    post({ kind: "reply", id, ok: false, error: describe(err) });
  }
}

ctx.onmessage = (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  switch (msg.kind) {
    case "boot":
      boot(msg.pyodideIndexUrl, msg.wheelUrls).catch((err) =>
        post({ kind: "bootFailed", error: describe(err) }),
      );
      break;
    case "call":
      void call(msg.id, msg.fn, msg.args);
      break;
    case "hidReply": {
      const waiter = pendingHid.get(msg.id);
      pendingHid.delete(msg.id);
      if (!waiter) break;
      if (msg.ok) waiter.resolve(msg.value);
      else waiter.reject(new Error(msg.error));
      break;
    }
  }
};

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

import type { HidTransport } from "../hid/transport.ts";
import { PYODIDE_INDEX_URL } from "../pyodide-version.ts";
import type { BootPhase, FromWorker, HidRequest, HidResponse, ToWorker } from "./protocol.ts";

export interface SessionEvents {
  status(phase: BootPhase): void;
  log(stream: "stdout" | "stderr", text: string): void;
}

/**
 * The page's handle on the Python worker, and the thing that services the
 * worker's HID requests. Every transfer Blinka makes lands in #serveHid and is
 * answered by whichever transport is installed -- real WebHID or the emulator.
 */
export class PythonSession {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  readonly #listeners: { [K in keyof SessionEvents]: Set<SessionEvents[K]> } = {
    status: new Set(),
    log: new Set(),
  };
  #transport: HidTransport | null = null;
  #seenDropped = 0;
  #nextId = 1;
  #booted: Promise<void> | null = null;
  #resolveBoot: (() => void) | null = null;
  #rejectBoot: ((e: Error) => void) | null = null;

  constructor() {
    this.#worker = new Worker(new URL("./pyworker.ts", import.meta.url), { type: "module" });
    this.#worker.onmessage = (event: MessageEvent<FromWorker>) => this.#onMessage(event.data);
    this.#worker.onerror = (event) => this.#rejectBoot?.(new Error(event.message));
  }

  /** Install the transport Python's `hid` module will talk to. */
  useTransport(transport: HidTransport): void {
    this.#transport = transport;
  }

  /** Start Pyodide and install the vendored wheels. Safe to await repeatedly. */
  boot(wheelUrls: string[]): Promise<void> {
    if (this.#booted) return this.#booted;
    this.#booted = new Promise<void>((resolve, reject) => {
      this.#resolveBoot = resolve;
      this.#rejectBoot = reject;
    });
    this.#send({ kind: "boot", pyodideIndexUrl: PYODIDE_INDEX_URL, wheelUrls });
    return this.#booted;
  }

  /** Invoke a @handler in python/webblinka/. */
  call<T>(fn: string, ...args: unknown[]): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.#send({ kind: "call", id, fn, args });
    });
  }

  on<K extends keyof SessionEvents>(event: K, fn: SessionEvents[K]): () => void {
    this.#listeners[event].add(fn);
    return () => void this.#listeners[event].delete(fn);
  }

  #send(message: ToWorker): void {
    this.#worker.postMessage(message);
  }

  #onMessage(msg: FromWorker): void {
    switch (msg.kind) {
      case "status":
        for (const fn of this.#listeners.status) fn(msg.phase);
        break;
      case "log":
        for (const fn of this.#listeners.log) fn(msg.stream, msg.text);
        break;
      case "ready":
        this.#resolveBoot?.();
        break;
      case "bootFailed":
        this.#rejectBoot?.(new Error(msg.error));
        break;
      case "reply": {
        const waiter = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (!waiter) break;
        if (msg.ok) waiter.resolve(msg.value as never);
        else waiter.reject(new Error(msg.error));
        break;
      }
      case "hid":
        void this.#serveHid(msg.id, msg.request);
        break;
    }
  }

  async #serveHid(id: number, request: HidRequest): Promise<void> {
    try {
      const value = await this.#runHid(request);
      this.#reportDesync();
      const transfer = value instanceof Uint8Array ? [value.buffer] : [];
      this.#worker.postMessage(
        { kind: "hidReply", id, ok: true, value } satisfies ToWorker,
        transfer as Transferable[],
      );
    } catch (err) {
      this.#worker.postMessage({
        kind: "hidReply",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies ToWorker);
    }
  }

  /**
   * The transport drops any reply still unread when the next command goes out.
   * With calls serialised that should never happen, so if it does, say so --
   * a silent resynchronisation would leave the next confusing bus error with no
   * explanation attached to it.
   */
  #reportDesync(): void {
    const dropped = this.#transport?.droppedReports ?? 0;
    if (dropped <= this.#seenDropped) return;
    const added = dropped - this.#seenDropped;
    this.#seenDropped = dropped;
    for (const fn of this.#listeners.log) {
      fn(
        "stderr",
        `Discarded ${added} orphaned HID ${added === 1 ? "reply" : "replies"} — ` +
          `two command streams crossed on the bus. Please report this.`,
      );
    }
  }

  #runHid(request: HidRequest): Promise<HidResponse> {
    const transport = this.#transport;
    if (!transport) throw new Error("no HID device is connected");
    switch (request.op) {
      case "enumerate":
        return transport.enumerate();
      case "open":
        return transport.open(request.vendorId, request.productId).then(() => null);
      case "write":
        return transport.write(request.data);
      case "read":
        return transport.read(request.length, request.timeoutMs);
      case "close":
        return transport.close().then(() => null);
    }
  }
}

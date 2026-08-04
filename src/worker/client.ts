import { HidTrace } from "../hid/trace.ts";
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
  /** Rolling record of HID traffic, dumped alongside any failed call. */
  readonly trace = new HidTrace();
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  readonly #listeners: { [K in keyof SessionEvents]: Set<SessionEvents[K]> } = {
    status: new Set(),
    log: new Set(),
  };
  #transport: HidTransport | null = null;
  #seenDropped = 0;
  #seenLate = 0;
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

  /**
   * Wait for the device to come back after a reset. Python is untouched by
   * this -- its `hid` module talks to the transport, not to a particular
   * HIDDevice, so swapping the handle underneath is invisible to Blinka.
   */
  async reacquire(timeoutMs = 6000): Promise<void> {
    if (!this.#transport) throw new Error("no HID device is connected");
    await this.#transport.reacquire(timeoutMs);
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
        if (msg.ok) {
          waiter.resolve(msg.value as never);
        } else {
          // Python's traceback says which line raised, never which bytes made
          // it raise. Attach the transfers around the failure.
          for (const fn of this.#listeners.log) fn("stderr", this.trace.format());
          waiter.reject(new Error(msg.error));
        }
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
   *
   * Two very different things cause that, and conflating them sends people
   * hunting for a concurrency bug that is not there. A reply to a read that
   * already timed out is explained -- the device answered late, we resynchronise
   * and move on. A reply nobody was waiting for is not, and means two command
   * streams crossed.
   */
  #reportDesync(): void {
    const dropped = this.#transport?.droppedReports ?? 0;
    const late = this.#transport?.lateReports ?? 0;

    if (late > this.#seenLate) {
      const added = late - this.#seenLate;
      this.#seenLate = late;
      this.#log(
        "stdout",
        `Discarded ${added} late HID ${added === 1 ? "reply" : "replies"} to a read ` +
          `that had already timed out. The bus is back in step; no action needed.`,
      );
    }

    if (dropped > this.#seenDropped) {
      const added = dropped - this.#seenDropped;
      this.#seenDropped = dropped;
      this.#log(
        "stderr",
        `Discarded ${added} orphaned HID ${added === 1 ? "reply" : "replies"} — ` +
          `two command streams crossed on the bus. Please report this.`,
      );
    }
  }

  #log(stream: "stdout" | "stderr", text: string): void {
    for (const fn of this.#listeners.log) fn(stream, text);
  }

  async #runHid(request: HidRequest): Promise<HidResponse> {
    const transport = this.#transport;
    if (!transport) throw new Error("no HID device is connected");
    switch (request.op) {
      case "enumerate":
        return transport.enumerate();
      case "open":
        return transport.open(request.vendorId, request.productId).then(() => null);
      case "write":
        this.trace.wrote(request.data);
        return transport.write(request.data);
      case "read":
        try {
          const reply = await transport.read(request.length, request.timeoutMs);
          this.trace.read(reply);
          return reply;
        } catch (err) {
          this.trace.failed(err instanceof Error ? err.message : String(err));
          throw err;
        }
      case "close":
        return transport.close().then(() => null);
    }
  }
}

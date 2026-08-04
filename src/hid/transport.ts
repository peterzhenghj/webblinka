/**
 * The transport contract is deliberately hidapi-shaped rather than WebHID-shaped:
 * `write` takes a buffer whose first byte is the report ID, and `read` returns
 * the report body without it. That is exactly what Python's `hid` module does,
 * so the shim in python/hid.py stays a dumb pass-through and every transport --
 * real hardware or the emulator -- is exercised through the same calls Blinka
 * itself makes.
 */
/**
 * Reports are always backed by a plain ArrayBuffer, never a SharedArrayBuffer:
 * they cross between page and worker as transferables, and JSPI means we never
 * needed shared memory in the first place.
 */
export type Report = Uint8Array<ArrayBuffer>;

export interface HidTransport {
  /** hidapi's hid.enumerate(): every MCP2221-class device we can talk to. */
  enumerate(): Promise<HidDeviceInfo[]>;
  open(vendorId: number, productId: number): Promise<void>;
  /** First byte is the report ID. Returns the number of bytes written. */
  write(data: Report): Promise<number>;
  /** Resolves with the next input report, or rejects on timeout. */
  read(length: number, timeoutMs: number): Promise<Report>;
  close(): Promise<void>;
  /**
   * Wait for the device to come back after a reset re-enumerated it, and take
   * hold of the new handle. Resolves once it is open and usable again.
   */
  reacquire(timeoutMs: number): Promise<void>;
  /**
   * Replies discarded because they were still unread when the next command went
   * out. Should always be zero; anything else means two command streams crossed.
   */
  readonly droppedReports: number;
}

/** The subset of hidapi's device dict that Blinka and PlatformDetect read. */
export interface HidDeviceInfo {
  vendor_id: number;
  product_id: number;
  product_string: string;
  manufacturer_string: string;
  serial_number: string;
  path: string;
}

export class HidTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`no HID input report within ${timeoutMs}ms`);
    this.name = "HidTimeoutError";
  }
}

export class HidNotOpenError extends Error {
  constructor() {
    super("HID device is not open");
    this.name = "HidNotOpenError";
  }
}

/**
 * Shared plumbing for the blocking-read semantics hidapi callers expect: reports
 * that arrive while nobody is reading queue up, and a read that arrives first
 * parks until the next report or the timeout, whichever comes first.
 */
export class ReportQueue {
  #reports: Report[] = [];
  #waiters: { resolve: (r: Report) => void; reject: (e: Error) => void; timer: number }[] = [];

  push(report: Report): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(report);
    } else {
      this.#reports.push(report);
    }
  }

  take(timeoutMs: number): Promise<Report> {
    const ready = this.#reports.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.#waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new HidTimeoutError(timeoutMs));
      }, timeoutMs) as unknown as number;
      this.#waiters.push({ resolve, reject, timer });
    });
  }

  /** Drop buffered reports so a stale reply can't be mistaken for a fresh one. */
  clear(): number {
    const dropped = this.#reports.length;
    this.#reports.length = 0;
    return dropped;
  }
}

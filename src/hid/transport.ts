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
   * Replies discarded because they were unread when the next command went out
   * and no read was waiting for them. Should always be zero; anything else means
   * two command streams crossed. Late replies to a read that timed out are
   * counted separately, because those are explained.
   */
  readonly droppedReports: number;
  /** Replies that arrived after the read waiting for them had given up. */
  readonly lateReports: number;
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
 * A timer that fires this much later than scheduled means the event loop was
 * starved, not that the device was slow. Input reports are delivered on the same
 * thread as the timer, so a stall delays both -- and the timer can win the race
 * even though the reply had already physically arrived.
 */
const STARVATION_SLACK_MS = 250;

/** How long to wait again after deciding a timeout was really a stall. */
const GRACE_MS = 500;

/**
 * Shared plumbing for the blocking-read semantics hidapi callers expect: reports
 * that arrive while nobody is reading queue up, and a read that arrives first
 * parks until the next report or the timeout, whichever comes first.
 *
 * hidapi's own read blocks indefinitely and Blinka is written against that, so
 * the timeout here exists only to stop a permanently wedged device hanging
 * Python forever. It should never fire on a device that is merely busy.
 */
export class ReportQueue {
  #reports: Report[] = [];
  #waiters: { resolve: (r: Report) => void; reject: (e: Error) => void; timer: number }[] = [];
  /**
   * Reads abandoned to a timeout whose reply has not turned up yet. Each one
   * licenses exactly one late report, which is a different thing from two
   * command streams crossing.
   */
  #abandoned = 0;

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
    return this.#park(timeoutMs, true);
  }

  #park(timeoutMs: number, allowGrace: boolean): Promise<Report> {
    return new Promise((resolve, reject) => {
      const scheduledFor = performance.now() + timeoutMs;
      const timer = setTimeout(() => {
        const i = this.#waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.#waiters.splice(i, 1);

        // If the timer itself ran late, the thread was blocked and the report
        // may be sitting immediately behind it. Waiting again costs a moment
        // and avoids failing a transfer the device actually answered.
        const lateBy = performance.now() - scheduledFor;
        if (allowGrace && lateBy > STARVATION_SLACK_MS) {
          this.#park(GRACE_MS, false).then(resolve, reject);
          return;
        }
        this.#abandoned++;
        reject(new HidTimeoutError(timeoutMs + (allowGrace ? 0 : GRACE_MS)));
      }, timeoutMs) as unknown as number;
      this.#waiters.push({ resolve, reject, timer });
    });
  }

  /**
   * Discard buffered reports before a new command, and say how many were truly
   * orphaned -- a reply to a read we gave up on is expected, not a symptom.
   */
  discardStale(): { orphaned: number; late: number } {
    const dropped = this.#reports.length;
    this.#reports.length = 0;
    const late = Math.min(dropped, this.#abandoned);
    this.#abandoned -= late;
    return { orphaned: dropped - late, late };
  }

  /** Reset on open: nothing from a previous session is worth keeping. */
  clear(): void {
    this.#reports.length = 0;
    this.#abandoned = 0;
  }
}

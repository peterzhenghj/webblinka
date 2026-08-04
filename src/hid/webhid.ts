import {
  HidNotOpenError,
  ReportQueue,
  type HidDeviceInfo,
  type HidTransport,
  type Report,
} from "./transport.ts";

export const MCP2221_VENDOR_ID = 0x04d8;
export const MCP2221_PRODUCT_ID = 0x00dd;

export function isWebHidAvailable(): boolean {
  return typeof navigator !== "undefined" && "hid" in navigator;
}

/**
 * Prompt for an MCP2221. Must be called from a user gesture, and only from the
 * main thread -- which is why Pyodide (in a worker) proxies its HID traffic here
 * rather than touching navigator.hid itself.
 */
export async function requestMcp2221(): Promise<HIDDevice | null> {
  // Filtering on vendor/product only. The command interface sits on a
  // vendor-defined usage page (0xff00), but adding that to the filter would hide
  // the device entirely on any firmware that reports it differently, and the
  // vid/pid pair is already unambiguous.
  const devices = await navigator.hid.requestDevice({
    filters: [{ vendorId: MCP2221_VENDOR_ID, productId: MCP2221_PRODUCT_ID }],
  });
  return devices[0] ?? null;
}

/** Devices the user has already granted us, so a reload need not re-prompt. */
export async function grantedMcp2221s(): Promise<HIDDevice[]> {
  const devices = await navigator.hid.getDevices();
  return devices.filter(
    (d) => d.vendorId === MCP2221_VENDOR_ID && d.productId === MCP2221_PRODUCT_ID,
  );
}

export class WebHidTransport implements HidTransport {
  droppedReports = 0;
  lateReports = 0;
  #device: HIDDevice;
  readonly #queue = new ReportQueue();
  #listening = false;

  constructor(device: HIDDevice) {
    this.#device = device;
  }

  get device(): HIDDevice {
    return this.#device;
  }

  /**
   * Wait out a reset. The chip drops off USB and comes back as a *different*
   * HIDDevice object, so the old handle is dead however healthy it looks --
   * everything above this class keeps its references and never finds out.
   */
  async reacquire(timeoutMs: number): Promise<void> {
    const replacement = await this.#awaitReconnect(timeoutMs);
    this.#detach();
    this.#device = replacement;
    await this.open(replacement.vendorId, replacement.productId);
  }

  #awaitReconnect(timeoutMs: number): Promise<HIDDevice> {
    const matches = (device: HIDDevice) =>
      device !== this.#device &&
      device.vendorId === MCP2221_VENDOR_ID &&
      device.productId === MCP2221_PRODUCT_ID;

    return new Promise<HIDDevice>((resolve, reject) => {
      const done = (device: HIDDevice) => {
        clearInterval(poll);
        clearTimeout(timer);
        navigator.hid.removeEventListener("connect", onConnect);
        resolve(device);
      };
      const onConnect = (event: HIDConnectionEvent) => {
        if (matches(event.device)) done(event.device);
      };
      navigator.hid.addEventListener("connect", onConnect);

      // The connect event is the fast path, but permission for a device with no
      // serial number can be re-granted without one firing, so also poll.
      const poll = setInterval(() => {
        void navigator.hid.getDevices().then((devices) => {
          const found = devices.find(matches);
          if (found) done(found);
        });
      }, 250) as unknown as number;

      const timer = setTimeout(() => {
        clearInterval(poll);
        navigator.hid.removeEventListener("connect", onConnect);
        reject(
          new Error(
            `the MCP2221 did not come back within ${timeoutMs}ms — unplug it and plug it back in`,
          ),
        );
      }, timeoutMs) as unknown as number;
    });
  }

  #detach(): void {
    if (this.#listening) {
      this.#device.removeEventListener("inputreport", this.#onInputReport);
      this.#listening = false;
    }
  }

  async enumerate(): Promise<HidDeviceInfo[]> {
    // We only ever hold the one device the user picked; PlatformDetect just
    // needs to see a matching vendor/product pair in the list.
    return [
      {
        vendor_id: this.#device.vendorId,
        product_id: this.#device.productId,
        product_string: this.#device.productName,
        manufacturer_string: "Microchip Technology Inc.",
        serial_number: "",
        path: "webhid:0",
      },
    ];
  }

  async open(vendorId: number, productId: number): Promise<void> {
    if (vendorId !== this.#device.vendorId || productId !== this.#device.productId) {
      throw new Error(
        `no device ${hex(vendorId)}:${hex(productId)} (holding ` +
          `${hex(this.#device.vendorId)}:${hex(this.#device.productId)})`,
      );
    }
    if (!this.#listening) {
      this.#device.addEventListener("inputreport", this.#onInputReport);
      this.#listening = true;
    }
    if (!this.#device.opened) await this.#device.open();
    // A reload can leave replies to the previous session's last command sitting
    // in the queue; they would desynchronise every subsequent transfer.
    this.#queue.clear();
  }

  async write(data: Report): Promise<number> {
    if (!this.#device.opened) throw new HidNotOpenError();
    // Every input report this chip sends answers a command, so anything still
    // queued when the next command goes out is orphaned -- and leaving it there
    // would shift every subsequent reply by one. Dropping it resynchronises.
    // With calls serialised this should never fire; the counter is how we find
    // out if it does.
    const stale = this.#queue.discardStale();
    this.droppedReports += stale.orphaned;
    this.lateReports += stale.late;

    // hidapi convention: byte 0 is the report ID, the rest is the report.
    const reportId = data[0] ?? 0;
    await this.#device.sendReport(reportId, data.subarray(1));
    return data.length;
  }

  async read(_length: number, timeoutMs: number): Promise<Report> {
    if (!this.#device.opened) throw new HidNotOpenError();
    return this.#queue.take(timeoutMs);
  }

  async close(): Promise<void> {
    // Deliberately not removing the inputreport listener or forgetting the
    // device: Blinka's MCP2221._reset() closes and immediately reopens, and
    // atexit closes on teardown. Reopening a forgotten device would re-prompt.
    if (this.#device.opened) await this.#device.close();
  }

  #onInputReport = (event: HIDInputReportEvent): void => {
    const view = event.data;
    // Copy: the event's buffer is reused, and this one gets transferred away.
    this.#queue.push(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice() as Report,
    );
  };
}

function hex(n: number): string {
  return `0x${n.toString(16).padStart(4, "0")}`;
}

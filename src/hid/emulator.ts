import { VirtualPa1010d } from "./devices/pa1010d.ts";
import { Mcp2221Emulator } from "./mcp2221-emulator.ts";
import { MCP2221_PRODUCT_ID, MCP2221_VENDOR_ID } from "./webhid.ts";
import { ReportQueue, type HidDeviceInfo, type HidTransport, type Report } from "./transport.ts";

/**
 * Feeds the emulated chip through the same HidTransport the real device uses,
 * so nothing above this line -- not the worker, not the hid shim, not Blinka --
 * can tell the difference.
 */
export class EmulatorTransport implements HidTransport {
  droppedReports = 0;
  readonly chip: Mcp2221Emulator;
  readonly #queue = new ReportQueue();
  readonly #transferDelayMs: number;
  #opened = false;

  /**
   * @param transferDelayMs Latency to add to each transfer. Zero keeps demo mode
   *   snappy, but real USB costs about a millisecond per report -- enough to
   *   turn timing bugs that are invisible here into certainties on hardware, so
   *   tests set it deliberately.
   */
  constructor(chip = defaultRig(), transferDelayMs = 0) {
    this.chip = chip;
    this.#transferDelayMs = transferDelayMs;
  }

  async enumerate(): Promise<HidDeviceInfo[]> {
    return [
      {
        vendor_id: MCP2221_VENDOR_ID,
        product_id: MCP2221_PRODUCT_ID,
        product_string: "MCP2221 (emulated)",
        manufacturer_string: "webblinka",
        serial_number: "demo",
        path: "emulator:0",
      },
    ];
  }

  async open(): Promise<void> {
    this.#opened = true;
    this.#queue.clear();
  }

  async write(data: Report): Promise<number> {
    if (!this.#opened) throw new Error("emulated device is not open");
    // Anything unread when a new command goes out is an orphaned reply; see the
    // matching comment in WebHidTransport.write.
    this.droppedReports += this.#queue.clear();
    await this.#delay();
    // Byte 0 is the hidapi report ID; the chip only sees the 64-byte report.
    const reply = this.chip.handle(data.subarray(1));
    if (reply) this.#queue.push(reply as Report);
    return data.length;
  }

  async read(_length: number, timeoutMs: number): Promise<Report> {
    if (!this.#opened) throw new Error("emulated device is not open");
    await this.#delay();
    return this.#queue.take(timeoutMs);
  }

  #delay(): Promise<void> {
    if (this.#transferDelayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.#transferDelayMs));
  }

  async close(): Promise<void> {
    this.#opened = false;
  }

  /** Nothing re-enumerates in software, so the handle is still good. */
  async reacquire(): Promise<void> {
    this.#queue.clear();
    this.#opened = true;
  }
}

/** The board demo mode presents: an MCP2221 with a GPS on the bus. */
export function defaultRig(): Mcp2221Emulator {
  const chip = new Mcp2221Emulator();
  // Start the cold start when the driver starts the module, not when the page
  // built the rig -- otherwise Pyodide's boot outlasts the acquisition and the
  // sky view is already full by the time anyone can look at it.
  chip.attach(new VirtualPa1010d({ acquireFromFirstCommand: true }));
  // A slowly wandering analog signal so the ADC readouts are not flatlined.
  const started = Date.now();
  const tick = () => {
    const t = (Date.now() - started) / 1000;
    chip.setAdc(0, 512 + 480 * Math.sin(t / 3));
    chip.setAdc(1, 512 + 300 * Math.sin(t / 7 + 1));
    chip.setAdc(2, 200);
  };
  tick();
  setInterval(tick, 100);
  return chip;
}

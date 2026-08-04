import { el, hex } from "../dom.ts";
import { panel } from "../panel.ts";

export interface ChipStatus {
  i2c: {
    state: number;
    stateName: string;
    cancellation: string;
    address: number;
    requestedTransferLength: number;
    transferredBytes: number;
    dataBufferCounter: number;
    speedDivider: number;
    timeoutMs: number;
    scl: number;
    sda: number;
    acked: boolean;
    pendingValue: number;
  };
  adc: { ch0: number; ch1: number; ch2: number };
  interruptEdgeDetected: boolean;
  revision: { hardware: string; firmware: string };
}

export interface BoardInfo {
  chip: string;
  board: string;
  pins: string[];
}

export interface RuntimeInfo {
  python: string;
  blinka: string;
  connected: boolean;
}

export interface CommonHandlers {
  status(): Promise<ChipStatus>;
  clearInterrupt(): Promise<void>;
}

const POLL_INTERVAL_MS = 1000;

/**
 * The chip's Status/Set Parameters report, which is the closest thing the
 * MCP2221 has to a dashboard: live ADC counts, the I2C engine's state machine,
 * and the silicon revision.
 */
export class CommonPanel {
  readonly root: HTMLElement;
  readonly #handlers: CommonHandlers;
  readonly #board: HTMLElement;
  readonly #values = new Map<string, HTMLElement>();
  #timer: number | null = null;
  #polling = false;

  constructor(handlers: CommonHandlers) {
    this.#handlers = handlers;
    this.root = el("div");

    const boardPanel = panel("Board");
    this.#board = boardPanel.body;
    this.#board.append(el("p", { class: "hint", text: "Not connected." }));

    const adc = panel("ADC");
    adc.body.append(
      this.#facts([
        ["adc.ch0", "Channel 0 (GP1)"],
        ["adc.ch1", "Channel 1 (GP2)"],
        ["adc.ch2", "Channel 2 (GP3)"],
      ]),
    );

    const interrupt = panel("Interrupt");
    const clear = el("button", { text: "Clear" });
    clear.addEventListener("click", () => void this.#clear(clear));
    interrupt.actions.append(clear);
    interrupt.body.append(this.#facts([["interrupt", "Edge detected"]]));

    const i2c = panel("I²C engine");
    i2c.body.append(
      this.#facts([
        ["i2c.stateName", "State"],
        ["i2c.address", "Address"],
        ["i2c.cancellation", "Cancellation"],
        ["i2c.requestedTransferLength", "Requested length"],
        ["i2c.transferredBytes", "Transferred"],
        ["i2c.dataBufferCounter", "Buffer counter"],
        ["i2c.speedDivider", "Speed divider"],
        ["i2c.timeoutMs", "Timeout"],
        ["i2c.scl", "SCL"],
        ["i2c.sda", "SDA"],
        ["i2c.acked", "Last address ACKed"],
        ["i2c.pendingValue", "Pending value"],
      ]),
    );

    this.root.append(boardPanel.root, adc.root, interrupt.root, i2c.root);
  }

  showBoard(board: BoardInfo, runtime: RuntimeInfo): void {
    this.#board.replaceChildren(
      el("dl", { class: "facts" }, [
        el("dt", { text: "Chip" }),
        el("dd", { text: board.chip }),
        el("dt", { text: "Board" }),
        el("dd", { text: board.board }),
        el("dt", { text: "Pins" }),
        el("dd", { text: board.pins.join(", ") || "none" }),
        el("dt", { text: "Revision" }),
        el("dd", { text: "—", id: "revision" }),
        el("dt", { text: "Blinka" }),
        el("dd", { text: runtime.blinka }),
        el("dt", { text: "Python" }),
        el("dd", { text: runtime.python }),
      ]),
    );
    const revision = this.#board.querySelector<HTMLElement>("#revision");
    if (revision) this.#values.set("revision", revision);
  }

  start(): void {
    if (this.#timer !== null) return;
    void this.#poll();
    this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS) as unknown as number;
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #clear(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await this.#handlers.clearInterrupt();
      await this.#poll();
    } finally {
      button.disabled = false;
    }
  }

  async #poll(): Promise<void> {
    // Calls to Python are serialised, so a slow operation elsewhere -- a bus
    // scan, a driver read -- delays this one. Skipping the tick keeps a backlog
    // of stale polls from queueing up behind it.
    if (this.#polling) return;
    this.#polling = true;
    let status: ChipStatus;
    try {
      status = await this.#handlers.status();
    } catch {
      return; // a transient bus error should not stop the timer
    } finally {
      this.#polling = false;
    }

    this.#set("adc.ch0", `${status.adc.ch0} · ${volts(status.adc.ch0)}`);
    this.#set("adc.ch1", `${status.adc.ch1} · ${volts(status.adc.ch1)}`);
    this.#set("adc.ch2", `${status.adc.ch2} · ${volts(status.adc.ch2)}`);
    this.#set("interrupt", status.interruptEdgeDetected ? "yes" : "no");
    this.#set("revision", `hardware ${status.revision.hardware}, firmware ${status.revision.firmware}`);

    this.#set("i2c.stateName", `${status.i2c.stateName} (${hex(status.i2c.state)})`);
    this.#set("i2c.address", hex(status.i2c.address));
    this.#set("i2c.cancellation", status.i2c.cancellation);
    this.#set("i2c.requestedTransferLength", `${status.i2c.requestedTransferLength} B`);
    this.#set("i2c.transferredBytes", `${status.i2c.transferredBytes} B`);
    this.#set("i2c.dataBufferCounter", String(status.i2c.dataBufferCounter));
    this.#set("i2c.speedDivider", String(status.i2c.speedDivider));
    this.#set("i2c.timeoutMs", `${status.i2c.timeoutMs} ms`);
    this.#set("i2c.scl", status.i2c.scl ? "high" : "low");
    this.#set("i2c.sda", status.i2c.sda ? "high" : "low");
    this.#set("i2c.acked", status.i2c.acked ? "yes" : "no");
    this.#set("i2c.pendingValue", String(status.i2c.pendingValue));
  }

  #facts(rows: [key: string, label: string][]): HTMLElement {
    const list = el("dl", { class: "facts" });
    for (const [key, label] of rows) {
      const value = el("dd", { text: "—" });
      this.#values.set(key, value);
      list.append(el("dt", { text: label }), value);
    }
    return list;
  }

  #set(key: string, text: string): void {
    const node = this.#values.get(key);
    if (node) node.textContent = text;
  }
}

/** The MCP2221's ADC is 10-bit against its selected reference; assume 3.3 V. */
function volts(counts: number): string {
  return `${((counts / 1023) * 3.3).toFixed(2)} V`;
}

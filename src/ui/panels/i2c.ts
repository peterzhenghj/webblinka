import { el, hex } from "../dom.ts";
import { panel } from "../panel.ts";

/** 0x00-0x07 and 0x78-0x7f are reserved by the I2C spec; busio never probes them. */
const FIRST = 0x08;
const LAST = 0x77;

const FREQUENCIES = [
  ["47000", "47 kHz"],
  ["100000", "100 kHz (default)"],
  ["400000", "400 kHz"],
] as const;

export interface I2cPanelHandlers {
  scan(): Promise<number[]>;
  setFrequency(hz: number): Promise<void>;
}

/** An i2cdetect-style map of the bus. */
export class I2cPanel {
  readonly root: HTMLElement;
  readonly #body: HTMLElement;
  readonly #scanButton: HTMLButtonElement;
  readonly #frequency: HTMLSelectElement;
  readonly #summary: HTMLParagraphElement;
  readonly #cells = new Map<number, HTMLTableCellElement>();
  readonly #handlers: I2cPanelHandlers;

  constructor(handlers: I2cPanelHandlers) {
    this.#handlers = handlers;
    const p = panel("I2C bus");
    this.root = p.root;
    this.#body = p.body;

    this.#frequency = el("select", { disabled: true, title: "Bus clock" });
    for (const [value, label] of FREQUENCIES) {
      this.#frequency.append(el("option", { value, text: label, selected: value === "100000" }));
    }
    this.#frequency.addEventListener("change", () => void this.#changeFrequency());

    this.#scanButton = el("button", { class: "primary", text: "Scan", disabled: true });
    this.#scanButton.addEventListener("click", () => void this.scan());

    p.actions.append(this.#frequency, this.#scanButton);

    this.#summary = el("p", { class: "hint", text: "Not scanned yet." });
    this.#body.append(this.#buildGrid(), this.#summary);
  }

  enable(): void {
    this.#scanButton.disabled = false;
    this.#frequency.disabled = false;
  }

  async scan(): Promise<number[]> {
    this.#scanButton.disabled = true;
    this.#summary.textContent = "Scanning 0x08–0x77…";
    const started = performance.now();
    try {
      const found = await this.#handlers.scan();
      for (const [address, cell] of this.#cells) {
        cell.dataset.found = String(found.includes(address));
      }
      const elapsed = Math.round(performance.now() - started);
      this.#summary.textContent = found.length
        ? `${found.length} device${found.length === 1 ? "" : "s"}: ` +
          `${found.map((a) => hex(a)).join(", ")} — ${elapsed} ms`
        : `No devices responded — ${elapsed} ms`;
      return found;
    } catch (err) {
      this.#summary.textContent = `Scan failed: ${err instanceof Error ? err.message : err}`;
      throw err;
    } finally {
      this.#scanButton.disabled = false;
    }
  }

  async #changeFrequency(): Promise<void> {
    this.#frequency.disabled = true;
    try {
      await this.#handlers.setFrequency(Number(this.#frequency.value));
    } finally {
      this.#frequency.disabled = false;
    }
  }

  #buildGrid(): HTMLTableElement {
    const table = el("table", { class: "i2c-grid" });
    const head = el("tr", {}, [el("th", { text: "" })]);
    for (let col = 0; col < 16; col++) {
      head.append(el("th", { text: col.toString(16) }));
    }
    table.append(head);

    for (let row = 0; row < 8; row++) {
      const tr = el("tr", {}, [el("th", { text: `${row.toString(16)}0` })]);
      for (let col = 0; col < 16; col++) {
        const address = row * 16 + col;
        const reserved = address < FIRST || address > LAST;
        const cell = el("td", { text: reserved ? "··" : hex(address).slice(2) });
        if (reserved) {
          cell.dataset.reserved = "true";
        } else {
          cell.title = hex(address);
          cell.dataset.found = "false";
          this.#cells.set(address, cell);
        }
        tr.append(cell);
      }
      table.append(tr);
    }
    return table;
  }
}

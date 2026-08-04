import { el } from "../dom.ts";
import { panel } from "../panel.ts";

export interface PinState {
  name: string;
  mode: PinMode;
  value: number;
}

export type PinMode = "input" | "output" | "analog_in" | "analog_out";

const MODE_LABELS: Record<PinMode | "off", string> = {
  off: "unused",
  input: "digital in",
  output: "digital out",
  analog_in: "analog in",
  analog_out: "analog out",
};

const POLL_INTERVAL_MS = 500;

export interface GpioHandlers {
  capabilities(): Promise<Record<string, PinMode[]>>;
  configure(name: string, mode: PinMode): Promise<PinState>;
  release(name: string): Promise<void>;
  write(name: string, value: number): Promise<PinState>;
  readAll(): Promise<PinState[]>;
}

/** One row per GP pin: pick a mode, then drive or watch it. */
export class GpioPanel {
  readonly root: HTMLElement;
  readonly #body: HTMLElement;
  readonly #handlers: GpioHandlers;
  readonly #rows = new Map<string, PinRow>();
  #timer: number | null = null;

  constructor(handlers: GpioHandlers) {
    this.#handlers = handlers;
    const p = panel("GPIO");
    this.root = p.root;
    this.#body = p.body;
    this.#body.append(el("p", { class: "hint", text: "Connect to configure pins." }));
  }

  async enable(): Promise<void> {
    const capabilities = await this.#handlers.capabilities();
    const table = el("table", { class: "pins" });
    for (const [name, modes] of Object.entries(capabilities)) {
      const row = new PinRow(name, modes, this.#handlers, () => this.#syncPolling());
      this.#rows.set(name, row);
      table.append(row.root);
    }
    this.#body.replaceChildren(table);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  #syncPolling(): void {
    // Only poll while something is readable; a bus that nobody is watching
    // should be quiet, especially with a driver sharing it.
    const readable = [...this.#rows.values()].some((row) => row.isReadable);
    if (readable && this.#timer === null) {
      this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS) as unknown as number;
    } else if (!readable && this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #poll(): Promise<void> {
    try {
      for (const state of await this.#handlers.readAll()) {
        this.#rows.get(state.name)?.show(state);
      }
    } catch {
      // A transient bus error should not kill the timer; the next tick retries.
    }
  }
}

class PinRow {
  readonly root: HTMLTableRowElement;
  readonly #name: string;
  readonly #handlers: GpioHandlers;
  readonly #onModeChange: () => void;
  readonly #mode: HTMLSelectElement;
  readonly #control: HTMLTableCellElement;
  readonly #value: HTMLTableCellElement;
  #current: PinMode | "off" = "off";

  constructor(name: string, modes: PinMode[], handlers: GpioHandlers, onModeChange: () => void) {
    this.#name = name;
    this.#handlers = handlers;
    this.#onModeChange = onModeChange;

    this.#mode = el("select");
    this.#mode.append(el("option", { value: "off", text: MODE_LABELS.off }));
    for (const mode of modes) {
      this.#mode.append(el("option", { value: mode, text: MODE_LABELS[mode] }));
    }
    this.#mode.addEventListener("change", () => void this.#applyMode());

    this.#control = el("td", { class: "pin-control" });
    this.#value = el("td", { class: "pin-value", text: "—" });
    this.root = el("tr", {}, [
      el("th", { text: name, scope: "row" }),
      el("td", {}, [this.#mode]),
      this.#control,
      this.#value,
    ]);
  }

  get isReadable(): boolean {
    return this.#current === "input" || this.#current === "analog_in";
  }

  show(state: PinState): void {
    if (state.mode === "analog_in") {
      // The MCP2221's ADC is 10-bit; Blinka reports it in CircuitPython's
      // 16-bit range, so show both the raw counts and the implied voltage.
      const volts = (state.value / 65535) * 3.3;
      this.#value.textContent = `${state.value} · ${volts.toFixed(2)} V`;
    } else if (state.mode === "input" || state.mode === "output") {
      this.#value.textContent = state.value ? "high" : "low";
    } else {
      this.#value.textContent = `${state.value}`;
    }
  }

  async #applyMode(): Promise<void> {
    const mode = this.#mode.value as PinMode | "off";
    this.#mode.disabled = true;
    try {
      if (mode === "off") {
        await this.#handlers.release(this.#name);
        this.#current = "off";
        this.#control.replaceChildren();
        this.#value.textContent = "—";
      } else {
        this.show(await this.#handlers.configure(this.#name, mode));
        this.#current = mode;
        this.#buildControl(mode);
      }
    } catch (err) {
      this.#value.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      this.#mode.disabled = false;
      this.#onModeChange();
    }
  }

  #buildControl(mode: PinMode): void {
    if (mode === "output") {
      const toggle = el("button", { text: "Set high" });
      let high = false;
      toggle.addEventListener("click", () => {
        high = !high;
        toggle.textContent = high ? "Set low" : "Set high";
        void this.#handlers.write(this.#name, high ? 1 : 0).then((state) => this.show(state));
      });
      this.#control.replaceChildren(toggle);
    } else if (mode === "analog_out") {
      const slider = el("input", { type: "range", min: "0", max: "65535", step: "2048", value: "0" });
      slider.addEventListener("input", () => {
        void this.#handlers.write(this.#name, Number(slider.value)).then((s) => this.show(s));
      });
      this.#control.replaceChildren(slider);
    } else {
      this.#control.replaceChildren();
    }
  }
}

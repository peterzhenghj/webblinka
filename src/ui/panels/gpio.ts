import { el } from "../dom.ts";
import { panel } from "../panel.ts";

/** Anything a pin can be. Only some of these have a CircuitPython equivalent. */
export type PinMode =
  | "input"
  | "output"
  | "analog_in"
  | "analog_out"
  | "sspnd"
  | "usb_config"
  | "clock_out"
  | "interrupt"
  | "led_uart_rx"
  | "led_uart_tx"
  | "led_i2c";

/** How the UI should present a mode, decided by the chip's own datasheet. */
export type PinKind = "digital" | "adc" | "dac" | "clock" | "interrupt" | "dedicated";

export interface PinModeSpec {
  mode: PinMode;
  label: string;
  kind: PinKind;
  code: number;
}

export interface PinState {
  name: string;
  mode: PinMode;
  kind: PinKind;
  value: number | null;
}

export interface GpSettings {
  clock: { dutyCycle: string; divider: string };
  dac: { referenceVoltage: string; referenceOption: string; value: number };
  adc: { referenceVoltage: string; referenceOption: string };
  interrupt: { edge: string };
}

export interface GpioHandlers {
  modes(): Promise<Record<string, PinModeSpec[]>>;
  configure(name: string, mode: PinMode): Promise<PinState>;
  release(name: string): Promise<void>;
  write(name: string, value: number): Promise<PinState>;
  readAll(): Promise<PinState[]>;
  settings(): Promise<{ gp: GpSettings }>;
  setClock(dutyCycle: string, divider: string): Promise<unknown>;
  setDacReference(voltage: string, option: string): Promise<unknown>;
  setDacValue(value: number): Promise<unknown>;
  setAdcReference(voltage: string, option: string): Promise<unknown>;
  setInterruptEdge(edge: string): Promise<unknown>;
}

const POLL_INTERVAL_MS = 500;
const VOLTAGES = ["off", "1.024V", "2.048V", "4.096V"];
const DUTY_CYCLES = ["0%", "25%", "50%", "75%"];
const DIVIDERS = ["24 MHz", "12 MHz", "6 MHz", "3 MHz", "1.5 MHz", "750 kHz", "375 kHz"];
const EDGES = ["off", "positive", "negative", "both"];

/**
 * One row per GP pin. The MCP2221 gives each pin a choice between GPIO and
 * several hardwired functions -- activity LEDs, a clock output, USB state
 * indicators, interrupt detection -- so the row shows whichever control that
 * designation actually has, and nothing where the chip drives the pin itself.
 *
 * The clock, reference-voltage and interrupt-edge settings below the table are
 * chip-wide rather than per-pin, which is why they are not in the rows.
 */
export class GpioPanel {
  readonly root: HTMLElement;
  readonly #handlers: GpioHandlers;
  readonly #pinsBody: HTMLElement;
  readonly #sharedBody: HTMLElement;
  readonly #rows = new Map<string, PinRow>();
  #timer: number | null = null;
  #visible = false;
  #polling = false;

  constructor(handlers: GpioHandlers) {
    this.#handlers = handlers;
    this.root = el("div");

    const pins = panel("Pin designations");
    this.#pinsBody = pins.body;
    this.#pinsBody.append(el("p", { class: "hint", text: "Not connected." }));

    const shared = panel("Chip-wide settings");
    this.#sharedBody = shared.body;
    this.#sharedBody.append(
      el("p", { class: "hint", text: "Clock, references and interrupt edge." }),
    );

    this.root.append(pins.root, shared.root);
  }

  async enable(): Promise<void> {
    const modes = await this.#handlers.modes();
    const table = el("table", { class: "pins" });
    for (const [name, specs] of Object.entries(modes)) {
      const row = new PinRow(name, specs, this.#handlers, () => this.#syncPolling());
      this.#rows.set(name, row);
      table.append(row.root);
    }
    this.#pinsBody.replaceChildren(table);
    await this.#buildShared();
  }

  show(): void {
    this.#visible = true;
    this.#syncPolling();
  }

  hide(): void {
    this.#visible = false;
    this.#syncPolling();
  }

  #syncPolling(): void {
    // Poll only while the tab is on screen and something is actually readable:
    // every tick is real traffic that competes with whatever else uses the bus.
    const wanted = this.#visible && [...this.#rows.values()].some((row) => row.isReadable);
    if (wanted && this.#timer === null) {
      this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS) as unknown as number;
    } else if (!wanted && this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #poll(): Promise<void> {
    // Skip rather than queue behind whatever else is using the serialised bus.
    if (this.#polling) return;
    this.#polling = true;
    try {
      for (const state of await this.#handlers.readAll()) {
        this.#rows.get(state.name)?.show(state);
      }
    } catch {
      // Transient bus errors are expected; the next tick retries.
    } finally {
      this.#polling = false;
    }
  }

  async #buildShared(): Promise<void> {
    const { gp } = await this.#handlers.settings();

    const clockDuty = select(DUTY_CYCLES, gp.clock.dutyCycle);
    const clockDivider = select(DIVIDERS, gp.clock.divider);
    const applyClock = () =>
      void this.#handlers.setClock(clockDuty.value, clockDivider.value);
    clockDuty.addEventListener("change", applyClock);
    clockDivider.addEventListener("change", applyClock);

    const dacVoltage = select(VOLTAGES, gp.dac.referenceVoltage);
    const dacOption = select(["Vdd", "Vrm"], gp.dac.referenceOption);
    const applyDac = () =>
      void this.#handlers.setDacReference(dacVoltage.value, dacOption.value);
    dacVoltage.addEventListener("change", applyDac);
    dacOption.addEventListener("change", applyDac);

    const adcVoltage = select(VOLTAGES, gp.adc.referenceVoltage);
    const adcOption = select(["Vdd", "Vrm"], gp.adc.referenceOption);
    const applyAdc = () =>
      void this.#handlers.setAdcReference(adcVoltage.value, adcOption.value);
    adcVoltage.addEventListener("change", applyAdc);
    adcOption.addEventListener("change", applyAdc);

    const edge = select(EDGES, gp.interrupt.edge);
    edge.addEventListener("change", () => void this.#handlers.setInterruptEdge(edge.value));

    this.#sharedBody.replaceChildren(
      group("Clock output", "Drives GP1 when it is designated Clock output.", [
        labelled("Duty cycle", clockDuty),
        labelled("Rate", clockDivider),
      ]),
      group("DAC reference", "Applies to whichever pin is designated as a DAC.", [
        labelled("Voltage", dacVoltage),
        labelled("Source", dacOption),
      ]),
      group(
        "ADC reference",
        "Applies to every pin designated as an ADC. Vdd measures against the USB " +
          "rail, so anything that loads it — another pin switching, say — moves " +
          "every channel at once. Vrm is an internal reference and is steadier.",
        [
          labelled("Voltage", adcVoltage),
          labelled("Source", adcOption),
        ],
      ),
      group("Interrupt on change", "Edge GP1 detects when designated for interrupts.", [
        labelled("Edge", edge),
      ]),
    );
  }
}

class PinRow {
  readonly root: HTMLTableRowElement;
  readonly #name: string;
  readonly #handlers: GpioHandlers;
  readonly #onModeChange: () => void;
  readonly #select: HTMLSelectElement;
  readonly #control: HTMLTableCellElement;
  readonly #value: HTMLTableCellElement;
  readonly #kinds: Map<string, PinKind>;
  #kind: PinKind | null = null;

  constructor(
    name: string,
    specs: PinModeSpec[],
    handlers: GpioHandlers,
    onModeChange: () => void,
  ) {
    this.#name = name;
    this.#handlers = handlers;
    this.#onModeChange = onModeChange;
    this.#kinds = new Map(specs.map((s) => [s.mode, s.kind]));

    this.#select = el("select");
    this.#select.append(el("option", { value: "off", text: "unused" }));
    for (const spec of specs) {
      this.#select.append(el("option", { value: spec.mode, text: spec.label }));
    }
    this.#select.addEventListener("change", () => void this.#apply());

    this.#control = el("td", { class: "pin-control" });
    this.#value = el("td", { class: "pin-value", text: "—" });
    this.root = el("tr", {}, [
      el("th", { text: name, scope: "row" }),
      el("td", {}, [this.#select]),
      this.#control,
      this.#value,
    ]);
  }

  get isReadable(): boolean {
    return this.#kind === "digital" || this.#kind === "adc";
  }

  show(state: PinState): void {
    if (state.value === null) {
      this.#value.textContent = "driven by chip";
      return;
    }
    if (state.kind === "adc") {
      // Blinka presents the MCP2221's 10-bit ADC in CircuitPython's 16-bit
      // range, so show the counts alongside the implied voltage.
      this.#value.textContent = `${state.value} · ${((state.value / 65535) * 3.3).toFixed(2)} V`;
    } else if (state.kind === "digital") {
      this.#value.textContent = state.value ? "high" : "low";
    } else {
      this.#value.textContent = String(state.value);
    }
  }

  async #apply(): Promise<void> {
    const mode = this.#select.value;
    this.#select.disabled = true;
    try {
      if (mode === "off") {
        await this.#handlers.release(this.#name);
        this.#kind = null;
        this.#control.replaceChildren();
        this.#value.textContent = "—";
      } else {
        const state = await this.#handlers.configure(this.#name, mode as PinMode);
        this.#kind = this.#kinds.get(mode) ?? null;
        this.#buildControl(this.#kind, mode as PinMode);
        this.show(state);
      }
    } catch (err) {
      this.#value.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      this.#select.disabled = false;
      this.#onModeChange();
    }
  }

  #buildControl(kind: PinKind | null, mode: PinMode): void {
    if (kind === "digital" && mode === "output") {
      const toggle = el("button", { text: "Set high" });
      let high = false;
      toggle.addEventListener("click", () => {
        high = !high;
        toggle.textContent = high ? "Set low" : "Set high";
        void this.#handlers.write(this.#name, high ? 1 : 0).then((s) => this.show(s));
      });
      this.#control.replaceChildren(toggle);
    } else if (kind === "dac") {
      const slider = el("input", {
        type: "range",
        min: "0",
        max: "65535",
        step: "2048",
        value: "0",
      });
      slider.addEventListener("input", () => {
        void this.#handlers.write(this.#name, Number(slider.value)).then((s) => this.show(s));
      });
      this.#control.replaceChildren(slider);
    } else {
      this.#control.replaceChildren();
    }
  }
}

// ------------------------------------------------------------------ helpers

function select(options: string[], selected: string): HTMLSelectElement {
  const node = el("select");
  for (const option of options) {
    node.append(el("option", { value: option, text: option, selected: option === selected }));
  }
  return node;
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  return el("label", { class: "field" }, [el("span", { text }), control]);
}

function group(title: string, hint: string, fields: HTMLElement[]): HTMLElement {
  return el("fieldset", { class: "settings-group" }, [
    el("legend", { text: title }),
    el("p", { class: "hint", text: hint }),
    el("div", { class: "fields" }, fields),
  ]);
}

import type { DevicePanel, DeviceSession } from "../../devices/panel.ts";
import { el } from "../dom.ts";
import { panel, statusPill } from "../panel.ts";

export interface Apds9960State {
  proximityEnabled: boolean;
  colorEnabled: boolean;
  gestureEnabled: boolean;
  proximity: number | null;
  gesture: number | null;
  color: { r: number; g: number; b: number; c: number } | null;
  colorReady: boolean;
  colorGain: number;
}

const GESTURE_NAMES: Record<number, string> = {
  1: "↑ Up",
  2: "↓ Down",
  3: "← Left",
  4: "→ Right",
};

const GAIN_LABELS = ["1×", "4×", "16×", "64×"];
const POLL_INTERVAL_MS = 300;

export class Apds9960Panel implements DevicePanel {
  readonly root: HTMLElement;
  readonly #session: DeviceSession;
  readonly #status = statusPill("Reading…", "busy");
  readonly #proximityValue = el("dd", {}, [el("span", { text: "—" })]);
  readonly #gestureValue = el("dd", {}, [el("span", { text: "—" })]);
  readonly #colorValue = el("dd", {}, [el("span", { text: "—" })]);
  readonly #colorPreview: HTMLDivElement;
  readonly #proxBar: HTMLDivElement;
  readonly #proxTrack: HTMLDivElement;
  #timer: number | null = null;
  #polling = false;

  constructor(session: DeviceSession) {
    this.#session = session;
    const p = panel("APDS9960");
    this.root = p.root;


    const proxToggle = this.#toggle("Proximity", "enable_proximity", true);
    const colorToggle = this.#toggle("Color", "enable_color", true);
    const gestureToggle = this.#toggle("Gesture", "enable_gesture", false);

    const gainSelect = el("select") as HTMLSelectElement;
    for (let i = 0; i < 4; i++) {
      gainSelect.append(
        el("option", { value: String(i), text: GAIN_LABELS[i]! }),
      );
    }
    gainSelect.addEventListener("change", () =>
      void this.#send("set_color_gain", [Number(gainSelect.value)]),
    );

    p.actions.append(
      this.#status.node,
      el("span", { class: "caption", text: "·" }),
      proxToggle,
      colorToggle,
      gestureToggle,
      el("label", { class: "field" }, [
        el("span", { text: "Gain" }),
        gainSelect,
      ]),
    );

    const facts = el("dl", { class: "facts" });
    facts.append(el("dt", { text: "Proximity" }), this.#proximityValue);
    facts.append(el("dt", { text: "Gesture" }), this.#gestureValue);
    facts.append(el("dt", { text: "Color" }), this.#colorValue);

    this.#proxBar = el("div", { class: "lux-gauge-fill" });
    this.#proxTrack = el("div", { class: "lux-gauge" }, [this.#proxBar]);
    this.#colorPreview = el("div", { class: "dial-face" });

    const rightCol = el("div", {}, [
      el("p", { class: "caption", text: "Proximity" }),
      this.#proxTrack,
      el("p", { class: "caption", text: "Color preview" }),
      this.#colorPreview,
    ]);

    p.body.append(
      el("div", { class: "gps-columns" }, [
        el("div", {}, [facts]),
        rightCol,
      ]),
    );
  }

  show(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS) as unknown as number;
    void this.#poll();
  }

  hide(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  #toggle(label: string, command: string, initial: boolean): HTMLLabelElement {
    const input = el("input", { type: "checkbox", checked: initial }) as HTMLInputElement;
    input.addEventListener("change", () => void this.#send(command, [input.checked]));
    return el("label", { class: "field" }, [
      input,
      el("span", { text: label }),
    ]);
  }

  async #send(command: string, args: unknown[]): Promise<void> {
    try {
      this.#render(await this.#session.command(command, ...args));
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async #poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      this.#render(await this.#session.poll());
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    } finally {
      this.#polling = false;
    }
  }

  #render(state: Apds9960State): void {
    if (state.proximity !== null) {
      const pct = (state.proximity / 255) * 100;
      this.#proxBar.style.width = `${pct}%`;
      this.#proximityValue.textContent = `${state.proximity} / 255`;
      this.#status.set(`${state.proximity} prox`, "ok");
    } else {
      this.#proxBar.style.width = "0%";
      this.#proximityValue.textContent = "off";
    }

    if (state.gesture !== null) {
      this.#gestureValue.textContent = GESTURE_NAMES[state.gesture] || `code ${state.gesture}`;
    } else {
      this.#gestureValue.textContent = state.gestureEnabled ? "—" : "disabled";
    }

  
    if (state.color) {
      const { r, g, b, c } = state.color;
      const rr = (r >> 8) & 0xff;
      const gg = (g >> 8) & 0xff;
      const bb = (b >> 8) & 0xff;
      this.#colorPreview.style.backgroundColor = `rgb(${rr},${gg},${bb})`;
      this.#colorValue.textContent = `R:${r} G:${g} B:${b} C:${c}`;
    } else {
      this.#colorPreview.style.backgroundColor = "transparent";
      this.#colorValue.textContent = state.colorEnabled ? "waiting…" : "disabled";
    }
  }
}
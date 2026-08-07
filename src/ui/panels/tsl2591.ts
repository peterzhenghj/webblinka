import type { DevicePanel, DeviceSession } from "../../devices/panel.ts";
import { el } from "../dom.ts";
import { panel, statusPill } from "../panel.ts";

export interface Tsl2591State {
  /** Absent when saturated: there is no bound to report, so none is shown. */
  lux: number | null;
  full: number;
  infrared: number;
  visible: number;
  visibleClamped: number;
  infraredFraction: number;
  gain: number;
  gainRegister: number;
  integrationMs: number;
  integrationRegister: number;
  fullScale: number;
  fillFraction: number;
  saturated: boolean;
  dark: boolean;
  atFloor: boolean;
  atCeiling: boolean;
  auto: boolean;
  settling: boolean;
  ranged: string;
  source: { kind: string; text: string };
  gains?: { register: number; multiplier: number }[];
  integrations?: { register: number; milliseconds: number }[];
}

const POLL_INTERVAL_MS = 500;

/**
 * Landmarks on the lux scale, because a bare illuminance figure means nothing
 * to most people. Log-spaced, which is the only way six orders of magnitude
 * fit on one bar -- and is also how the eye responds, so the spacing is closer
 * to perceptual than a linear axis would be.
 */
const LANDMARKS: { lux: number; label: string }[] = [
  { lux: 0.001, label: "moonless" },
  { lux: 0.25, label: "full moon" },
  { lux: 50, label: "living room" },
  // Deliberately sparse at the top. An office at 400 lx and an overcast day at
  // 1000 are a factor of two and a half apart, which is a couple of millimetres
  // here -- labelling both crowds the scale to say almost nothing.
  { lux: 1000, label: "overcast" },
  { lux: 20000, label: "shade" },
  { lux: 100000, label: "direct sun" },
];

const SCALE_MIN = Math.log10(0.001);
const SCALE_MAX = Math.log10(120000);

/**
 * Illuminance, with the two things a lux figure cannot tell you on its own.
 *
 * The first is whether the number is real. This part covers six orders of
 * magnitude, but only if the gain and integration time suit the light, and at
 * either end of its range it returns a confident-looking figure that is a floor
 * or a ceiling rather than a measurement. So the ADC's fill level is drawn
 * beside the reading, and saturation greys it out rather than leaving it
 * looking authoritative.
 *
 * The second is what the light is. The part measures infrared separately, and
 * the ratio between the channels is a property of the illuminant rather than
 * its brightness -- free information from the same two registers.
 */
export class Tsl2591Panel implements DevicePanel {
  readonly root: HTMLElement;
  readonly #session: DeviceSession;
  readonly #status = statusPill("Reading…", "busy");
  readonly #reading = el("p", { class: "lux-reading" });
  readonly #note = el("p", { class: "aht-note" });
  readonly #scale = el("div", { class: "lux-scale" });
  readonly #fill = el("div", { class: "lux-fill" });
  readonly #facts = new Map<string, HTMLElement>();
  readonly #auto: HTMLInputElement;
  readonly #gain: HTMLSelectElement;
  readonly #integration: HTMLSelectElement;
  #timer: number | null = null;
  #polling = false;
  #optionsBuilt = false;

  constructor(session: DeviceSession) {
    this.#session = session;
    const p = panel("Illuminance");
    this.root = p.root;

    this.#auto = el("input", { type: "checkbox", checked: true }) as HTMLInputElement;
    this.#auto.addEventListener("change", () => {
      void this.#send("set_auto", this.#auto.checked);
    });

    this.#gain = el("select", {
      title:
        "Analogue gain. Raises the count for the same light — the way to read a " +
        "dark room, and the first thing to lower when the reading saturates.",
    }) as HTMLSelectElement;
    this.#gain.addEventListener("change", () => {
      void this.#send("set_gain", Number(this.#gain.value));
    });

    this.#integration = el("select", {
      title:
        "How long the ADC accumulates. Longer trades response time for a larger " +
        "count and less noise; at 100 ms the counter also stops at 36863, not 65535.",
    }) as HTMLSelectElement;
    this.#integration.addEventListener("change", () => {
      void this.#send("set_integration", Number(this.#integration.value));
    });

    p.actions.append(this.#status.node);

    const facts = el("dl", { class: "facts" });
    for (const [key, label] of [
      ["visible", "Visible"],
      ["infrared", "Infrared"],
      ["full", "Full spectrum"],
      ["ratio", "Infrared share"],
      ["range", "Range"],
      ["headroom", "ADC headroom"],
    ] as const) {
      const value = el("dd", {}, [el("span", { text: "—" })]);
      this.#facts.set(key, value);
      facts.append(el("dt", { text: label }), value);
    }

    const controls = el("div", { class: "lux-controls" }, [
      el("label", {}, [this.#auto, el("span", { text: "Auto-range" })]),
      el("label", {}, [el("span", { text: "Gain" }), this.#gain]),
      el("label", {}, [el("span", { text: "Integration" }), this.#integration]),
    ]);

    p.body.append(
      el("div", { class: "gps-columns" }, [
        el("div", {}, [this.#reading, this.#scale, this.#note, facts]),
        el("div", {}, [
          el("p", { class: "lux-fill-label", text: "ADC fill" }),
          this.#fill,
          el("p", {
            class: "caption",
            text:
              "How much of the converter's range the reading uses. Near the top " +
              "there is no room left for the light to rise; near the bottom the " +
              "figure is mostly quantisation.",
          }),
          controls,
        ]),
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

  async #send(command: string, ...args: unknown[]): Promise<void> {
    try {
      await this.#session.command<Tsl2591State>(command, ...args);
      await this.#poll();
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async #poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      this.#render(await this.#session.poll<Tsl2591State>());
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    } finally {
      this.#polling = false;
    }
  }

  #render(state: Tsl2591State): void {
    this.#buildOptions(state);
    // Only when the user is not mid-interaction: auto-ranging rewrites these
    // constantly, and stamping over a select someone just opened is maddening.
    if (document.activeElement !== this.#gain) this.#gain.value = String(state.gainRegister);
    if (document.activeElement !== this.#integration) {
      this.#integration.value = String(state.integrationRegister);
    }
    this.#auto.checked = state.auto;
    this.#gain.disabled = false;
    this.#integration.disabled = false;

    const trustworthy = state.lux !== null && !state.settling;
    // No number at all when saturated, rather than a greyed one. A figure on
    // the screen is a figure someone will read off, and there isn't one.
    this.#reading.textContent = state.lux === null ? "over range" : formatLux(state.lux);
    this.#reading.classList.toggle("unusable", !trustworthy);

    this.#status.set(
      state.saturated ? "saturated" : state.settling ? "ranging…" : formatLux(state.lux ?? 0),
      state.saturated ? "error" : state.settling ? "busy" : "ok",
    );

    this.#set("visible", `${state.visibleClamped} counts`);
    this.#set("infrared", `${state.infrared} counts`);
    this.#set("full", `${state.full} of ${state.fullScale}`);
    this.#set("ratio", `${(state.infraredFraction * 100).toFixed(0)}%`);
    this.#set("range", `${state.gain}× · ${state.integrationMs.toFixed(0)} ms`);
    this.#set("headroom", `${(state.fillFraction * 100).toFixed(1)}% of full scale`);

    this.#note.textContent = this.#verdict(state);
    this.#renderScale(state, trustworthy);
    this.#renderFill(state);
  }

  #verdict(state: Tsl2591State): string {
    if (state.saturated && state.atFloor) {
      return (
        "Saturated at the least sensitive setting the part has — this is brighter " +
        "than a TSL2591 can measure, and there is no reading to be had."
      );
    }
    if (state.saturated) {
      return state.auto
        ? "Saturated — both channels are pinned. Lowering the range."
        : "Saturated — both channels are pinned. Lower the gain, or turn auto-range back on.";
    }
    if (state.settling) return "Settling after a range change; this reading is from the old one.";
    if (state.dark && state.atCeiling) {
      return "Below what the part can resolve, even at maximum sensitivity.";
    }
    if (state.dark && !state.auto) {
      return "Barely using the converter — raise the gain, or turn auto-range back on.";
    }
    return state.source.text;
  }

  /** The reading's place on a log lux scale, against everyday landmarks. */
  #renderScale(state: Tsl2591State, trustworthy: boolean): void {
    const marker = el("div", { class: trustworthy ? "lux-marker" : "lux-marker unusable" });
    // Pinned to the top of the scale when saturated. The light really is out
    // beyond there; it is only how far that is unknown.
    marker.style.left = percent(state.lux === null ? 1 : fraction(state.lux));

    // A mark on the track and a label under it. Without the mark a rotated
    // label only implies where it points, and at this density implying is not
    // enough -- "overcast" and "shade" lean past each other.
    const marks = LANDMARKS.map((landmark) => {
      const mark = el("div", { class: "lux-notch" });
      mark.style.left = percent(fraction(landmark.lux));
      return mark;
    });
    const ticks = LANDMARKS.map((landmark) => {
      const tick = el("span", { class: "lux-tick", text: landmark.label });
      tick.style.left = percent(fraction(landmark.lux));
      return tick;
    });

    this.#scale.replaceChildren(
      el("div", { class: "lux-track" }, [...marks, marker]),
      el("div", { class: "lux-ticks" }, ticks),
    );
  }

  #renderFill(state: Tsl2591State): void {
    const used = Math.max(0, Math.min(1, state.fillFraction));
    const tone = state.saturated ? "over" : state.dark ? "under" : "ok";
    const bar = el("div", { class: "lux-gauge-fill" });
    bar.style.height = percent(used);

    this.#fill.replaceChildren(
      el("div", { class: `lux-gauge ${tone}` }, [bar]),
      el("p", { class: "lux-gauge-value", text: `${(used * 100).toFixed(1)}%` }),
    );
  }

  #buildOptions(state: Tsl2591State): void {
    if (this.#optionsBuilt || !state.gains || !state.integrations) return;
    this.#optionsBuilt = true;
    for (const gain of state.gains) {
      this.#gain.append(
        el("option", { value: String(gain.register), text: `${gain.multiplier}×` }),
      );
    }
    for (const integration of state.integrations) {
      this.#integration.append(
        el("option", {
          value: String(integration.register),
          text: `${integration.milliseconds} ms`,
        }),
      );
    }
  }

  #set(key: string, text: string): void {
    const node = this.#facts.get(key);
    if (node) node.textContent = text;
  }
}

function percent(of: number): string {
  return `${(of * 100).toFixed(2)}%`;
}

function fraction(lux: number): number {
  const clamped = Math.max(10 ** SCALE_MIN, Math.min(10 ** SCALE_MAX, lux));
  return (Math.log10(clamped) - SCALE_MIN) / (SCALE_MAX - SCALE_MIN);
}

/** Significant figures the part can actually justify, across six decades. */
function formatLux(lux: number): string {
  if (lux >= 10000) return `${(lux / 1000).toFixed(1)}k lx`;
  if (lux >= 100) return `${lux.toFixed(0)} lx`;
  if (lux >= 1) return `${lux.toFixed(1)} lx`;
  if (lux >= 0.01) return `${lux.toFixed(3)} lx`;
  return `${lux.toFixed(4)} lx`;
}

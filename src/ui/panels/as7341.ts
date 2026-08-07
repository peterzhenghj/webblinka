import type { DevicePanel, DeviceSession } from "../../devices/panel.ts";
import { el, svg } from "../dom.ts";
import { panel, statusPill } from "../panel.ts";

export interface As7341State {
  wavelengths: number[];
  counts: number[];
  basic: number[];
  clear: number;
  nir: number;
  clearBasic: number;
  nirBasic: number;
  saturated: boolean[];
  clearSaturated: boolean;
  gain: number;
  gainRegister: number;
  atime: number;
  astep: number;
  integrationMs: number;
  fullScale: number;
  led: boolean;
  ledCurrent: number;
  gains: { register: number; multiplier: number }[];
}

/**
 * Approximate sRGB for each channel's centre wavelength.
 *
 * Hard-coded for the eight fixed centres rather than computed: a
 * wavelength-to-colour approximation is a pile of piecewise curves that would
 * be wrong in its own way, and these are the only eight values it would ever
 * be asked for.
 */
const CHANNEL_COLOURS = [
  "#8b00ff", // 415 violet
  "#3200ff", // 445 indigo
  "#00a2ff", // 480 blue
  "#00ff5a", // 515 cyan-green
  "#7cff00", // 555 green
  "#ffe000", // 590 yellow
  "#ff7b00", // 630 orange
  "#ff1000", // 680 red
];

const POLL_INTERVAL_MS = 1500;
const CHART_W = 460;
const CHART_H = 190;

/**
 * The eight-channel spectrum, drawn.
 *
 * Plotted in basic counts rather than raw ones. Raw counts scale with the gain
 * and the integration time, so a spectrum drawn from them changes height --
 * and, once anything clips, shape -- when you touch a setting, even though the
 * light has not moved. Normalising by gain and time is what makes two readings
 * comparable, and is what ams's own application notes do.
 *
 * A saturated channel is called out rather than plotted as though it were a
 * measurement: at full scale the ADC is reporting a floor, and the bars either
 * side of it are describing a spectrum that does not exist.
 */
export class As7341Panel implements DevicePanel {
  readonly root: HTMLElement;
  readonly #session: DeviceSession;
  readonly #status = statusPill("Reading…", "busy");
  readonly #chart = el("div", { class: "spectrum" });
  readonly #legend = el("p", { class: "hint" });
  readonly #warning = el("p", { class: "aht-note" });
  readonly #facts = el("dl", { class: "facts" });
  readonly #gain: HTMLSelectElement;
  readonly #atime: HTMLInputElement;
  readonly #astep: HTMLInputElement;
  readonly #led: HTMLButtonElement;
  #timer: number | null = null;
  #polling = false;
  #ledOn = false;

  constructor(session: DeviceSession) {
    this.#session = session;
    const p = panel("Spectrum");
    this.root = p.root;
    p.actions.append(this.#status.node);

    this.#gain = el("select", { title: "ADC gain. Higher sees dimmer light, and saturates sooner." });
    this.#gain.addEventListener("change", () => void this.#setGain());

    this.#atime = el("input", { type: "text", value: "100", class: "mono short" });
    this.#astep = el("input", { type: "text", value: "999", class: "mono short" });
    const apply = el("button", { text: "Apply" });
    apply.addEventListener("click", () => void this.#setIntegration());

    this.#led = el("button", {
      text: "LED on",
      title:
        "The breakout's white illumination LED, for looking at reflected " +
        "colour rather than ambient light. It is bright.",
    });
    this.#led.addEventListener("click", () => void this.#toggleLed());

    p.body.append(
      this.#chart,
      this.#legend,
      this.#warning,
      this.#facts,
      el("fieldset", { class: "settings-group" }, [
        el("legend", { text: "Exposure" }),
        el("p", {
          class: "hint",
          text:
            "Integration time is (ATIME + 1) × (ASTEP + 1) × 2.78 µs. Gain and " +
            "time trade against each other: both raise the counts, and both " +
            "run into full scale. Basic counts divide them back out, so the " +
            "plot above should barely move when you change either — if it " +
            "does, something is clipping.",
        }),
        el("div", { class: "fields" }, [
          el("label", { class: "field" }, [el("span", { text: "Gain" }), this.#gain]),
          el("label", { class: "field" }, [el("span", { text: "ATIME" }), this.#atime]),
          el("label", { class: "field" }, [el("span", { text: "ASTEP" }), this.#astep]),
          apply,
          this.#led,
        ]),
      ]),
    );
  }

  show(): void {
    if (this.#timer !== null) return;
    // Slower than the other panels on purpose: one reading is two full
    // integrations plus two SMUX reconfigurations, so a fast poll would hold
    // the bus down for nothing.
    this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS) as unknown as number;
    void this.#poll();
  }

  hide(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      this.#render(await this.#session.poll<As7341State>());
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    } finally {
      this.#polling = false;
    }
  }

  async #setGain(): Promise<void> {
    await this.#apply(() => this.#session.command("set_gain", Number(this.#gain.value)));
  }

  async #setIntegration(): Promise<void> {
    const atime = Number.parseInt(this.#atime.value, 10);
    const astep = Number.parseInt(this.#astep.value, 10);
    if (!Number.isFinite(atime) || !Number.isFinite(astep)) {
      this.#warning.textContent = "ATIME and ASTEP must be whole numbers.";
      return;
    }
    await this.#apply(() => this.#session.command("set_integration", atime, astep));
  }

  async #toggleLed(): Promise<void> {
    this.#ledOn = !this.#ledOn;
    await this.#apply(() => this.#session.command("set_led", this.#ledOn, 10));
    this.#led.textContent = this.#ledOn ? "LED off" : "LED on";
  }

  async #apply(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      await this.#poll();
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    }
  }

  #render(state: As7341State): void {
    if (this.#gain.options.length === 0) {
      for (const gain of state.gains) {
        this.#gain.append(
          el("option", { value: String(gain.register), text: `${gain.multiplier}×` }),
        );
      }
    }
    this.#gain.value = String(state.gainRegister);
    if (document.activeElement !== this.#atime) this.#atime.value = String(state.atime);
    if (document.activeElement !== this.#astep) this.#astep.value = String(state.astep);

    this.#renderChart(state);

    const saturated = state.saturated
      .map((hit, i) => (hit ? `${state.wavelengths[i]} nm` : null))
      .filter(Boolean);
    if (saturated.length > 0) {
      this.#warning.textContent =
        `Saturated at ${saturated.join(", ")}${state.clearSaturated ? " and clear" : ""}. ` +
        `Those channels are pinned at full scale (${state.fullScale}), so they are a ` +
        `floor rather than a reading and the spectrum's shape cannot be trusted. ` +
        `Drop the gain or shorten the integration.`;
    } else if (state.clearSaturated) {
      this.#warning.textContent =
        "The clear channel is saturated. The colour channels are still below " +
        "full scale, but there is more light here than the current settings can take.";
    } else {
      this.#warning.textContent = "";
    }

    const peak = state.basic.indexOf(Math.max(...state.basic));
    this.#status.set(`peak ${state.wavelengths[peak]} nm`, saturated.length ? "busy" : "ok");

    this.#facts.replaceChildren(
      el("dt", { text: "Clear" }),
      el("dd", {}, [el("span", { text: `${state.clear} · ${state.clearBasic.toFixed(3)} basic` })]),
      el("dt", { text: "Near-IR" }),
      el("dd", {}, [el("span", { text: `${state.nir} · ${state.nirBasic.toFixed(3)} basic` })]),
      el("dt", { text: "Exposure" }),
      el("dd", {}, [
        el("span", {
          text:
            `${state.gain}× gain, ${state.integrationMs.toFixed(1)} ms ` +
            `(full scale ${state.fullScale})`,
        }),
      ]),
      el("dt", { text: "LED" }),
      el("dd", {}, [el("span", { text: state.led ? `on, ${state.ledCurrent} mA` : "off" })]),
    );
  }

  #renderChart(state: As7341State): void {
    const peak = Math.max(...state.basic, 1e-9);
    const slot = CHART_W / state.basic.length;
    const barWidth = slot * 0.68;

    const bars = state.basic.map((value, i) => {
      const height = Math.max(1, (value / peak) * (CHART_H - 34));
      const x = i * slot + (slot - barWidth) / 2;
      const colour = CHANNEL_COLOURS[i] ?? "#888";
      const saturated = state.saturated[i] ?? false;
      return svg("g", {}, [
        svg("title", {}, [
          `${state.wavelengths[i]} nm — ${state.counts[i]} counts, ` +
            `${state.basic[i]?.toFixed(4)} basic` +
            (saturated ? " — saturated, this is a floor not a reading" : ""),
        ]),
        svg("rect", {
          x,
          y: CHART_H - 22 - height,
          width: barWidth,
          height,
          rx: 2,
          fill: colour,
          // A saturated bar is drawn hollow, so it reads as "not a measurement"
          // rather than as the tallest thing on the chart.
          "fill-opacity": saturated ? 0.2 : 0.85,
          stroke: saturated ? colour : "none",
          "stroke-dasharray": saturated ? "3 2" : "none",
        }),
        svg(
          "text",
          { x: x + barWidth / 2, y: CHART_H - 8, "text-anchor": "middle", class: "spectrum-label" },
          [String(state.wavelengths[i])],
        ),
      ]);
    });

    this.#chart.replaceChildren(
      svg("svg", { viewBox: `0 0 ${CHART_W} ${CHART_H}`, class: "spectrum-svg" }, [
        svg("line", {
          x1: 0,
          y1: CHART_H - 22,
          x2: CHART_W,
          y2: CHART_H - 22,
          class: "spectrum-axis",
        }),
        ...bars,
      ]),
    );

    this.#legend.textContent =
      `Basic counts — raw divided by gain and integration time, so the shape is ` +
      `the light rather than the settings. Peak ${peak.toFixed(3)} at ` +
      `${state.wavelengths[state.basic.indexOf(Math.max(...state.basic))]} nm.`;
  }
}

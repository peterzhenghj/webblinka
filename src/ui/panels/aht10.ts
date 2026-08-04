import type { DevicePanel, DeviceSession } from "../../devices/panel.ts";
import { el, svg } from "../dom.ts";
import { panel, statusPill } from "../panel.ts";

export interface AhtState {
  temperatureC: number;
  temperatureF: number;
  relativeHumidity: number;
  dewPointC: number | null;
  absoluteHumidity: number;
  status: number;
}

const POLL_INTERVAL_MS = 1000;
const HISTORY_SECONDS = 300;

/** Below this much change per minute the reading has stopped moving. */
const SETTLED_C_PER_MIN = 0.1;
/** Dew point within this of ambient means surfaces are at risk of wetting. */
const CONDENSATION_MARGIN_C = 2.5;

const CHART_W = 240;
const CHART_H = 96;

interface Sample {
  at: number;
  temperatureC: number;
  relativeHumidity: number;
}

/**
 * Temperature and humidity, plus the two things the part does not measure and
 * everyone actually wants: the dew point, and whether the reading has settled.
 *
 * The settling matters more than it sounds. An AHT10 self-heats -- its own die
 * warms the humidity element -- so for a minute or two after power-up, or after
 * being handled, it reads high on temperature and low on humidity while it
 * equilibrates. A single number gives no clue which half of that you are
 * looking at, and someone reading 23.4 C off a sensor that is still coming down
 * from 25 has no way to know. Hence the trend, and hence saying plainly when it
 * has stopped moving.
 */
export class AhtPanel implements DevicePanel {
  readonly root: HTMLElement;
  readonly #session: DeviceSession;
  readonly #status = statusPill("Starting…", "busy");
  readonly #facts = new Map<string, HTMLElement>();
  readonly #chart = el("div", { class: "aht-chart" });
  readonly #chartNote = el("p", { class: "hint" });
  readonly #note = el("p", { class: "aht-note" });
  readonly #history: Sample[] = [];
  #timer: number | null = null;
  #polling = false;

  constructor(session: DeviceSession) {
    this.#session = session;
    const p = panel("Reading");
    this.root = p.root;

    const reset = el("button", {
      text: "Reset sensor",
      title: "Soft-reset and recalibrate. Also restarts the settling window.",
    });
    reset.addEventListener("click", () => void this.#reset(reset));
    p.actions.append(this.#status.node, reset);

    const facts = el("dl", { class: "facts" });
    for (const [key, label] of [
      ["temperature", "Temperature"],
      ["humidity", "Relative humidity"],
      ["dewPoint", "Dew point"],
      ["absolute", "Absolute humidity"],
      ["trend", "Trend"],
      ["status", "Status byte"],
    ] as const) {
      const value = el("dd", { text: "—" });
      this.#facts.set(key, value);
      facts.append(el("dt", { text: label }), value);
    }

    p.body.append(
      el("div", { class: "gps-columns" }, [
        el("div", {}, [facts, this.#note]),
        el("div", {}, [
          el("h3", { class: "subhead", text: "Last 5 minutes" }),
          this.#chart,
          this.#chartNote,
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

  async #reset(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    this.#status.set("Resetting…", "busy");
    try {
      await this.#session.command("reset");
      // The history describes a sensor that no longer exists: it was just
      // recalibrated, and the whole point of the window is the settling.
      this.#history.length = 0;
      await this.#poll();
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    } finally {
      button.disabled = false;
    }
  }

  async #poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    let state: AhtState;
    try {
      state = await this.#session.poll<AhtState>();
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
      return;
    } finally {
      this.#polling = false;
    }

    const now = Date.now();
    this.#history.push({
      at: now,
      temperatureC: state.temperatureC,
      relativeHumidity: state.relativeHumidity,
    });
    while (this.#history[0] && now - this.#history[0].at > HISTORY_SECONDS * 1000) {
      this.#history.shift();
    }

    const drift = this.#driftPerMinute();
    const settled = drift !== null && Math.abs(drift) < SETTLED_C_PER_MIN;

    this.#status.set(
      `${state.temperatureC.toFixed(1)} °C · ${state.relativeHumidity.toFixed(0)}% RH`,
      settled ? "ok" : "busy",
    );

    this.#set("temperature", `${state.temperatureC.toFixed(2)} °C · ${state.temperatureF.toFixed(1)} °F`);
    this.#set("humidity", `${state.relativeHumidity.toFixed(2)} %`);
    this.#set(
      "dewPoint",
      state.dewPointC === null ? "—" : `${state.dewPointC.toFixed(2)} °C`,
    );
    this.#set("absolute", `${state.absoluteHumidity.toFixed(2)} g/m³`);
    this.#set("trend", describeDrift(drift, settled));
    this.#set("status", `0x${state.status.toString(16).padStart(2, "0")} · calibrated`);

    this.#note.textContent = advice(state, settled);
    this.#renderChart();
  }

  #driftPerMinute(): number | null {
    // Compare against a sample about a minute back rather than the immediately
    // previous one: consecutive readings differ by sensor noise, which would
    // swamp the actual trend.
    const latest = this.#history.at(-1);
    if (!latest) return null;
    const earlier = this.#history.find((s) => latest.at - s.at <= 60_000);
    if (!earlier || earlier === latest) return null;
    const minutes = (latest.at - earlier.at) / 60_000;
    if (minutes < 0.25) return null; // too short a baseline to mean anything
    return (latest.temperatureC - earlier.temperatureC) / minutes;
  }

  #renderChart(): void {
    if (this.#history.length < 2) {
      this.#chart.replaceChildren();
      this.#chartNote.textContent = "Collecting…";
      return;
    }

    const temps = this.#history.map((s) => s.temperatureC);
    const humidity = this.#history.map((s) => s.relativeHumidity);
    const first = this.#history[0]!.at;
    const last = this.#history.at(-1)!.at;
    const span = Math.max(last - first, 1000);

    const line = (values: number[], className: string) => {
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      // A flat trace should sit as a flat line in the middle, not get amplified
      // into a mountain range by autoscaling to its own noise.
      const range = Math.max(hi - lo, 0.5);
      const mid = (hi + lo) / 2;
      const points = values.map((value, i) => {
        const x = ((this.#history[i]!.at - first) / span) * CHART_W;
        const y = CHART_H / 2 - ((value - mid) / range) * (CHART_H * 0.8);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      return { node: svg("polyline", { points: points.join(" "), class: className }), lo, hi };
    };

    const t = line(temps, "aht-trace-temp");
    const h = line(humidity, "aht-trace-humidity");

    this.#chart.replaceChildren(
      svg("svg", { viewBox: `0 0 ${CHART_W} ${CHART_H}`, class: "aht-chart-svg" }, [
        svg("line", { x1: 0, y1: CHART_H / 2, x2: CHART_W, y2: CHART_H / 2, class: "aht-axis" }),
        t.node,
        h.node,
      ]),
    );

    const minutes = Math.round(span / 60_000);
    this.#chartNote.textContent =
      `Temperature ${t.lo.toFixed(2)}–${t.hi.toFixed(2)} °C\n` +
      `Humidity ${h.lo.toFixed(1)}–${h.hi.toFixed(1)} %\n` +
      `${this.#history.length} samples over ${minutes < 1 ? "under a minute" : `${minutes} min`}`;
    this.#chartNote.title =
      "Each trace is scaled to its own range, so they show shape rather than " +
      "absolute level. Temperature rising while humidity falls is the sensor " +
      "warming itself, not the room changing.";
  }

  #set(key: string, text: string): void {
    const node = this.#facts.get(key);
    if (node) node.textContent = text;
  }
}

function describeDrift(drift: number | null, settled: boolean): string {
  if (drift === null) return "measuring…";
  if (settled) return `settled (${drift >= 0 ? "+" : ""}${drift.toFixed(2)} °C/min)`;
  return `${drift >= 0 ? "rising" : "falling"} ${Math.abs(drift).toFixed(2)} °C/min`;
}

function advice(state: AhtState, settled: boolean): string {
  if (state.dewPointC !== null && state.temperatureC - state.dewPointC < CONDENSATION_MARGIN_C) {
    return (
      `Dew point is within ${(state.temperatureC - state.dewPointC).toFixed(1)} °C of ambient — ` +
      `anything cooler than ${state.dewPointC.toFixed(1)} °C will condense.`
    );
  }
  if (!settled) {
    return (
      "Still moving. An AHT10 self-heats, so it reads high on temperature and " +
      "low on humidity for a minute or two after power-up or handling."
    );
  }
  return "";
}

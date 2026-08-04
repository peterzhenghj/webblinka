import type { DevicePanel, DeviceSession } from "../../devices/panel.ts";
import { el } from "../dom.ts";
import { panel, statusPill } from "../panel.ts";
import { GpsMap } from "./gps-map.ts";

export interface Satellite {
  prn: string;
  elevation: number | null;
  azimuth: number | null;
  snr: number | null;
  used: boolean;
}

export interface GpsState {
  hasFix: boolean;
  has3dFix: boolean;
  fixQuality: number | null;
  fixMode: number | null;
  satellites: number | null;
  sky: Satellite[];
  latitude: number | null;
  longitude: number | null;
  altitudeM: number | null;
  geoidHeightM: number | null;
  pdop: number | null;
  hdop: number | null;
  vdop: number | null;
  speedKnots: number | null;
  trackAngleDeg: number | null;
  timestampUtc: string | null;
  elapsedS: number;
  timeToFirstFixS: number | null;
  sentenceCount: number;
  sentences: string[];
  updates: number;
}

const POLL_INTERVAL_MS = 1000;

/** A satellite has to be heard this well before it is much use in a solution. */
const USABLE_SNR = 20;
/** Full-scale for the signal bars. Real receivers rarely exceed the mid-40s. */
const MAX_SNR = 50;

/**
 * Lock status first, because that is the thing you are actually waiting on --
 * then the evidence that it is making progress towards one.
 *
 * A GPS that has been told to acquire looks identical to a broken one for the
 * first thirty seconds unless you can see the sky view: satellites appearing
 * and their signal climbing is the difference between "working on it" and "not
 * seeing any sky". That is why the signal bars are as prominent as the fix.
 *
 * The driver is already running by the time this exists -- the shell starts it
 * when the panel is opened -- so there is no Start button, only polling that
 * follows the tab being visible.
 */
export class GpsPanel implements DevicePanel {
  readonly root: HTMLElement;
  readonly #body: HTMLElement;
  readonly #status = statusPill("Starting…", "busy");
  readonly #session: DeviceSession;
  readonly #facts = new Map<string, HTMLElement>();
  readonly #progress = el("p", { class: "gps-progress", text: "" });
  readonly #sky = el("div", { class: "sky" });
  readonly #skyNote = el("p", { class: "hint", text: "Waiting for the first satellite report…" });
  readonly #raw = el("pre", { class: "log" });
  readonly #map = new GpsMap();
  #timer: number | null = null;
  #polling = false;

  constructor(session: DeviceSession) {
    this.#session = session;
    // No address here: the shell's device header already carries it, and panel
    // titles are uppercased, which turns 0x10 into 0X10.
    const p = panel("Fix");
    this.root = p.root;
    this.#body = p.body;

    const rate = el("select", { title: "Fix rate" });
    for (const [ms, label] of [
      ["1000", "1 Hz"],
      ["2000", "0.5 Hz"],
      ["200", "5 Hz"],
    ] as const) {
      rate.append(el("option", { value: ms, text: label, selected: ms === "1000" }));
    }
    rate.addEventListener("change", () => {
      void this.#session.command("set_rate", Number(rate.value));
    });
    p.actions.append(this.#status.node, rate);

    const facts = el("dl", { class: "facts" });
    for (const [key, label] of [
      ["fix", "Fix"],
      ["satellites", "Satellites"],
      ["latitude", "Latitude"],
      ["longitude", "Longitude"],
      ["altitudeM", "Altitude"],
      ["dop", "DOP (P/H/V)"],
      ["speedKnots", "Speed"],
      ["trackAngleDeg", "Track"],
      ["timestampUtc", "UTC"],
      ["sentenceCount", "NMEA sentences"],
    ] as const) {
      const value = el("dd", { text: "—" });
      this.#facts.set(key, value);
      facts.append(el("dt", { text: label }), value);
    }

    this.#body.append(
      this.#progress,
      // Above the sky view: once there is a fix, where it is landing is the
      // thing you want, and the satellites become the explanation for it.
      this.#map.root,
      el("div", { class: "sky-block" }, [
        el("h3", { class: "subhead", text: "Satellites in view" }),
        this.#sky,
        this.#skyNote,
      ]),
      facts,
      this.#raw,
    );
  }

  show(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS) as unknown as number;
    void this.#poll();
  }

  hide(): void {
    // A receiver keeps its almanac and its fix while nobody is watching, so
    // stopping the polling costs nothing but the bus traffic it saves.
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #poll(): Promise<void> {
    // Skip rather than queue behind whatever else is using the serialised bus.
    if (this.#polling) return;
    this.#polling = true;
    let state: GpsState;
    try {
      state = await this.#session.poll<GpsState>();
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
      return;
    } finally {
      this.#polling = false;
    }

    const used = state.sky.filter((sat) => sat.used).length;
    this.#status.set(
      state.hasFix
        ? `${state.has3dFix ? "3D" : "2D"} fix — ${used || (state.satellites ?? "?")} satellites`
        : "Acquiring…",
      state.hasFix ? "ok" : "busy",
    );

    this.#progress.textContent = progressLine(state, used);
    this.#map.update(state);
    this.#renderSky(state.sky);

    this.#set("fix", fixDescription(state));
    this.#set("satellites", satelliteSummary(state, used));
    this.#set("latitude", state.latitude, (v) => `${v.toFixed(6)}°`);
    this.#set("longitude", state.longitude, (v) => `${v.toFixed(6)}°`);
    this.#set("altitudeM", state.altitudeM, (v) => `${v.toFixed(1)} m`);
    this.#set("dop", dop(state));
    this.#set("speedKnots", state.speedKnots, (v) => `${v.toFixed(2)} kn`);
    this.#set("trackAngleDeg", state.trackAngleDeg, (v) => `${v.toFixed(1)}°`);
    this.#set("timestampUtc", state.timestampUtc);
    this.#set("sentenceCount", state.sentenceCount);

    if (state.sentences.length) this.#raw.textContent = state.sentences.join("\n");
  }

  #renderSky(sky: Satellite[]): void {
    if (sky.length === 0) {
      this.#sky.replaceChildren();
      this.#skyNote.textContent =
        "No satellites reported yet. The module sends its sky view every few " +
        "seconds; if this stays empty, it likely cannot see any sky.";
      return;
    }

    this.#sky.replaceChildren(
      ...sky.map((sat) => {
        const snr = sat.snr ?? 0;
        const bar = el("div", { class: "sat-bar" });
        bar.style.height = `${Math.min(100, (snr / MAX_SNR) * 100)}%`;
        const column = el("div", { class: "sat" }, [
          el("div", { class: "sat-track" }, [bar]),
          el("span", { class: "sat-snr", text: snr ? String(snr) : "—" }),
          el("span", { class: "sat-prn", text: sat.prn.replace(/^GP/, "") }),
        ]);
        column.dataset.state = sat.used ? "used" : snr >= USABLE_SNR ? "usable" : "weak";
        column.title =
          `${sat.prn}: ${snr || 0} dB-Hz` +
          (sat.elevation !== null ? `, elevation ${sat.elevation}°` : "") +
          (sat.azimuth !== null ? `, azimuth ${sat.azimuth}°` : "") +
          (sat.used ? " — used in the solution" : "");
        return column;
      }),
    );

    const used = sky.filter((s) => s.used).length;
    const usable = sky.filter((s) => (s.snr ?? 0) >= USABLE_SNR).length;
    this.#skyNote.textContent =
      `${sky.length} in view, ${usable} above ${USABLE_SNR} dB-Hz, ${used} used in the fix. ` +
      `Bars are signal-to-noise; a solution needs four usable satellites.`;
  }

  #set(key: string, value: unknown, format?: (v: number) => string): void {
    const node = this.#facts.get(key);
    if (!node) return;
    if (value === null || value === undefined) node.textContent = "—";
    else if (typeof value === "number" && format) node.textContent = format(value);
    else node.textContent = String(value);
  }
}

// ------------------------------------------------------------------ formatting

/** The one line that answers "is this thing getting anywhere?". */
function progressLine(state: GpsState, used: number): string {
  const elapsed = `${state.elapsedS.toFixed(0)}s`;
  if (state.hasFix) {
    const ttff =
      state.timeToFirstFixS !== null ? `first fix after ${state.timeToFirstFixS}s` : "fixed";
    return `Running ${elapsed} — ${ttff}, holding on ${used} satellites.`;
  }
  const usable = state.sky.filter((s) => (s.snr ?? 0) >= USABLE_SNR).length;
  if (state.sky.length === 0) {
    return `Acquiring for ${elapsed} — no satellites heard yet.`;
  }
  const inView = state.sky.length === 1 ? "1 satellite" : `${state.sky.length} satellites`;
  return (
    `Acquiring for ${elapsed} — ${inView} in view, ` +
    `${usable} of the four needed are strong enough.`
  );
}

function fixDescription(state: GpsState): string {
  const mode = state.fixMode === 3 ? "3D" : state.fixMode === 2 ? "2D" : "none";
  const quality =
    state.fixQuality === 2 ? "differential" : state.fixQuality === 1 ? "GPS" : "invalid";
  return state.hasFix ? `${mode} (${quality})` : "no fix";
}

function satelliteSummary(state: GpsState, used: number): string {
  const inView = state.sky.length || state.satellites;
  if (inView === null) return "—";
  return `${used} used of ${inView} in view`;
}

function dop(state: GpsState): string {
  const show = (value: number | null) => (value === null ? "—" : value.toFixed(2));
  if (state.pdop === null && state.hdop === null && state.vdop === null) return "—";
  return `${show(state.pdop)} / ${show(state.hdop)} / ${show(state.vdop)}`;
}

import { el } from "../dom.ts";
import { panel, statusPill } from "../panel.ts";

export interface GpsState {
  hasFix: boolean;
  has3dFix: boolean;
  fixQuality: number | null;
  satellites: number | null;
  latitude: number | null;
  longitude: number | null;
  altitudeM: number | null;
  hdop: number | null;
  speedKnots: number | null;
  trackAngleDeg: number | null;
  timestampUtc: string | null;
  sentences: string[];
  updates: number;
}

const POLL_INTERVAL_MS = 1000;

export interface GpsHandlers {
  start(address: number): Promise<{ address: number }>;
  poll(): Promise<GpsState>;
  stop(): Promise<void>;
}

/** Lock status first, because that is the thing you are actually waiting on. */
export class GpsPanel {
  readonly root: HTMLElement;
  readonly #body: HTMLElement;
  readonly #button: HTMLButtonElement;
  readonly #status = statusPill("Not started");
  readonly #handlers: GpsHandlers;
  readonly #facts = new Map<string, HTMLElement>();
  readonly #raw = el("pre", { class: "log" });
  readonly #hint: HTMLElement;
  #timer: number | null = null;
  #running = false;

  constructor(handlers: GpsHandlers) {
    this.#handlers = handlers;
    const p = panel("GPS — PA1010D");
    this.root = p.root;
    this.#body = p.body;

    this.#button = el("button", { text: "Start", disabled: true });
    this.#button.addEventListener("click", () => void this.toggle());
    p.actions.append(this.#status.node, this.#button);

    const facts = el("dl", { class: "facts" });
    for (const [key, label] of [
      ["satellites", "Satellites"],
      ["latitude", "Latitude"],
      ["longitude", "Longitude"],
      ["altitudeM", "Altitude"],
      ["hdop", "HDOP"],
      ["speedKnots", "Speed"],
      ["timestampUtc", "UTC"],
    ] as const) {
      const value = el("dd", { text: "—" });
      this.#facts.set(key, value);
      facts.append(el("dt", { text: label }), value);
    }
    this.#hint = el("p", {
      class: "hint",
      text: "Scan the bus first; the module answers at 0x10.",
    });
    this.#body.append(this.#hint, facts, this.#raw);
  }

  /** Called after a scan; the panel only offers to start if the part is there. */
  setPresent(present: boolean): void {
    this.#button.disabled = !present;
    if (!present) this.#status.set("Not on the bus", "idle");
    else if (!this.#running) this.#status.set("Ready", "idle");
  }

  async toggle(): Promise<void> {
    if (this.#running) {
      await this.stop();
      return;
    }
    this.#button.disabled = true;
    try {
      await this.#handlers.start(0x10);
      this.#running = true;
      this.#hint.remove();
      this.#button.textContent = "Stop";
      this.#status.set("Acquiring…", "busy");
      this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS) as unknown as number;
      await this.#poll();
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    } finally {
      this.#button.disabled = false;
    }
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#running = false;
    this.#button.textContent = "Start";
    this.#status.set("Stopped", "idle");
    await this.#handlers.stop();
  }

  async #poll(): Promise<void> {
    let state: GpsState;
    try {
      state = await this.#handlers.poll();
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
      return;
    }

    this.#status.set(
      state.hasFix
        ? `${state.has3dFix ? "3D" : "2D"} fix — ${state.satellites ?? "?"} satellites`
        : "Acquiring…",
      state.hasFix ? "ok" : "busy",
    );

    this.#set("satellites", state.satellites);
    this.#set("latitude", state.latitude, (v) => `${v.toFixed(6)}°`);
    this.#set("longitude", state.longitude, (v) => `${v.toFixed(6)}°`);
    this.#set("altitudeM", state.altitudeM, (v) => `${v.toFixed(1)} m`);
    this.#set("hdop", state.hdop, (v) => v.toFixed(2));
    this.#set("speedKnots", state.speedKnots, (v) => `${v.toFixed(2)} kn`);
    this.#set("timestampUtc", state.timestampUtc);

    if (state.sentences.length) this.#raw.textContent = state.sentences.join("\n");
  }

  #set(key: string, value: unknown, format?: (v: number) => string): void {
    const node = this.#facts.get(key);
    if (!node) return;
    if (value === null || value === undefined) node.textContent = "—";
    else if (typeof value === "number" && format) node.textContent = format(value);
    else node.textContent = String(value);
  }
}

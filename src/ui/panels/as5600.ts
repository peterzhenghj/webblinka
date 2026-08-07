import type { DevicePanel, DeviceSession } from "../../devices/panel.ts";
import { el, svg } from "../dom.ts";
import { panel, statusPill } from "../panel.ts";

export interface As5600State {
  raw: number;
  scaled: number;
  rawDegrees: number;
  degrees: number;
  turns: number;
  continuousDegrees: number;
  speedDps: number;
  speedRpm: number;
  zeroPosition: number;
  agc: number;
  magnitude: number;
  magnetDetected: boolean;
  magnetTooWeak: boolean;
  magnetTooStrong: boolean;
  magnet: { state: "ok" | "weak" | "strong" | "absent"; tone: string; text: string };
}

const POLL_INTERVAL_MS = 200;
const DIAL = 200;

/**
 * A shaft angle, drawn as a dial, with the magnet's health above it.
 *
 * The health comes first because the angle cannot tell you anything about it.
 * The part reports a clean-looking number between 0 and 360 whether the magnet
 * is well placed, too far, too close, or absent -- and in that last case it is
 * reporting noise while looking exactly like a working encoder. The status bits
 * and the gain are the only things that say otherwise, so when they say the
 * magnet is wrong the dial is greyed rather than left looking authoritative.
 */
export class As5600Panel implements DevicePanel {
  readonly root: HTMLElement;
  readonly #session: DeviceSession;
  readonly #status = statusPill("Reading…", "busy");
  readonly #dial = el("div", { class: "dial" });
  readonly #verdict = el("p", { class: "aht-note" });
  readonly #facts = new Map<string, HTMLElement>();
  #timer: number | null = null;
  #polling = false;

  constructor(session: DeviceSession) {
    this.#session = session;
    const p = panel("Angle");
    this.root = p.root;

    const zero = el("button", {
      text: "Zero here",
      title:
        "Writes the current shaft position into ZPOS, so this becomes 0°. " +
        "The raw angle is untouched — it is the shaft, not your datum.",
    });
    zero.addEventListener("click", () => void this.#run("set_zero_here", zero));

    const turns = el("button", { text: "Reset turns", title: "Set the revolution count back to zero." });
    turns.addEventListener("click", () => void this.#run("reset_turns", turns));

    p.actions.append(this.#status.node, turns, zero);

    const facts = el("dl", { class: "facts" });
    for (const [key, label] of [
      ["angle", "Angle"],
      ["raw", "Raw angle"],
      ["continuous", "Continuous"],
      ["speed", "Speed"],
      ["gain", "Automatic gain"],
      ["magnitude", "Field magnitude"],
    ] as const) {
      const value = el("dd", {}, [el("span", { text: "—" })]);
      this.#facts.set(key, value);
      facts.append(el("dt", { text: label }), value);
    }

    p.body.append(
      el("div", { class: "gps-columns" }, [
        el("div", {}, [facts, this.#verdict]),
        el("div", {}, [this.#dial]),
      ]),
    );
  }

  show(): void {
    if (this.#timer !== null) return;
    // Faster than the other panels: this is the one where you turn something
    // and watch it move, and each reading is a handful of registers.
    this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS) as unknown as number;
    void this.#poll();
  }

  hide(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #run(command: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      this.#render(await this.#session.command<As5600State>(command));
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    } finally {
      button.disabled = false;
    }
  }

  async #poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      this.#render(await this.#session.poll<As5600State>());
    } catch (err) {
      this.#status.set(err instanceof Error ? err.message : String(err), "error");
    } finally {
      this.#polling = false;
    }
  }

  #render(state: As5600State): void {
    const usable = state.magnet.state === "ok";
    this.#status.set(usable ? `${state.degrees.toFixed(1)}°` : "magnet", usable ? "ok" : "busy");

    this.#set("angle", `${state.degrees.toFixed(2)}° · ${state.scaled} of 4096`);
    this.#set("raw", `${state.rawDegrees.toFixed(2)}° · zero at ${state.zeroPosition}`);
    this.#set(
      "continuous",
      `${state.continuousDegrees.toFixed(1)}° · ${state.turns} turn${
        Math.abs(state.turns) === 1 ? "" : "s"
      }`,
    );
    this.#set("speed", `${state.speedRpm.toFixed(1)} rpm · ${state.speedDps.toFixed(0)}°/s`);
    this.#set("gain", `${state.agc}`);
    this.#set("magnitude", `${state.magnitude}`);

    this.#verdict.textContent = state.magnet.state === "ok" ? "" : state.magnet.text;
    this.#renderDial(state, usable);
  }

  #renderDial(state: As5600State, usable: boolean): void {
    const centre = DIAL / 2;
    const radius = centre - 14;
    // Zero at the top and clockwise, which is how a dial reads.
    const radians = ((state.degrees - 90) * Math.PI) / 180;

    const ticks = Array.from({ length: 12 }, (_, i) => {
      const angle = ((i * 30 - 90) * Math.PI) / 180;
      const inner = i % 3 === 0 ? radius - 10 : radius - 5;
      return svg("line", {
        x1: centre + Math.cos(angle) * inner,
        y1: centre + Math.sin(angle) * inner,
        x2: centre + Math.cos(angle) * radius,
        y2: centre + Math.sin(angle) * radius,
        class: "dial-tick",
      });
    });

    this.#dial.replaceChildren(
      svg(
        "svg",
        { viewBox: `0 0 ${DIAL} ${DIAL}`, class: usable ? "dial-svg" : "dial-svg unusable" },
        [
          svg("circle", { cx: centre, cy: centre, r: radius, class: "dial-face" }),
          ...ticks,
          svg("line", {
            x1: centre,
            y1: centre,
            x2: centre + Math.cos(radians) * (radius - 16),
            y2: centre + Math.sin(radians) * (radius - 16),
            class: "dial-needle",
          }),
          svg("circle", { cx: centre, cy: centre, r: 4, class: "dial-hub" }),
          svg(
            "text",
            { x: centre, y: centre + radius - 2, "text-anchor": "middle", class: "dial-label" },
            [usable ? `${state.degrees.toFixed(1)}°` : "no magnet"],
          ),
        ],
      ),
    );
  }

  #set(key: string, text: string): void {
    const node = this.#facts.get(key);
    if (node) node.textContent = text;
  }
}

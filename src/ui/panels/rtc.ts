import type { DevicePanel, DeviceSession } from "../../devices/panel.ts";
import { el } from "../dom.ts";
import { panel, statusPill } from "../panel.ts";

export interface RtcFlag {
  label: string;
  value: string;
  tone: "ok" | "warn" | "error";
  /** A driver command that resolves this flag, when one exists. */
  action?: string | null;
}

export interface RtcState {
  label: string;
  address: number;
  iso: string;
  deviceUnix: number;
  hostUnix: number;
  offsetS: number;
  uncertaintyS: number;
  elapsedS: number;
  driftPpm: number | null;
  resolutionPpm: number | null;
  resolutionS: number;
  identity: string | null;
  flags: RtcFlag[];
}

const POLL_INTERVAL_MS = 1000;

/**
 * Any I2C real-time clock. Nothing here knows which part it is talking to --
 * the driver supplies the time, the status rows and the resolution, so
 * DS3231, DS1307 and PCF8563 need a driver each and no UI at all.
 *
 * It leads with the offset from the host clock rather than the time, because
 * the time is the part of an RTC you can least easily be wrong about: a clock
 * showing the wrong century is obvious, and one losing a second a day looks
 * perfect. The drift rate is the number worth having, so the panel measures it
 * across the session and states the precision that measurement currently
 * supports — over a short window the answer is quantisation, and reporting
 * "±420 ppm so far" is worth more than a confident 3.
 */
export class RtcPanel implements DevicePanel {
  readonly root: HTMLElement;
  readonly #session: DeviceSession;
  readonly #status = statusPill("Reading…", "busy");
  readonly #clock = el("div", { class: "rtc-clock", text: "—" });
  readonly #offset = el("p", { class: "rtc-offset" });
  readonly #drift = el("p", { class: "hint" });
  readonly #flags = el("dl", { class: "facts" });
  readonly #message = el("p", { class: "hint" });
  #timer: number | null = null;
  #polling = false;

  constructor(session: DeviceSession) {
    this.#session = session;
    const p = panel("Clock");
    this.root = p.root;

    const sync = el("button", {
      class: "primary",
      text: "Set from this computer",
      title: "Writes the browser's current UTC into the clock.",
    });
    sync.addEventListener("click", () => void this.#sync(sync));

    const restart = el("button", {
      text: "Restart drift",
      title: "Forget the baseline and start measuring the rate again from now.",
    });
    restart.addEventListener("click", () => void this.#restart(restart));

    p.actions.append(this.#status.node, restart, sync);
    p.body.append(
      this.#clock,
      this.#offset,
      this.#drift,
      this.#flags,
      this.#message,
      el("p", {
        class: "hint",
        text:
          "The clock is read and written as UTC. These parts store a bare " +
          "calendar with no time zone, so something has to choose, and UTC is " +
          "the choice that keeps the drift figure meaningful across a change " +
          "of season.",
      }),
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

  async #sync(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      // Sampled here rather than in Python so the value is the host's own
      // clock at the moment of asking; the transfer that follows is the error.
      const state = await this.#session.command<RtcState>("set_from_unix", Date.now() / 1000);
      this.#render(state);
      this.#message.textContent =
        "Set. Anything under a few tens of milliseconds out is the write itself, " +
        "not the clock.";
    } catch (err) {
      this.#fail(err);
    } finally {
      button.disabled = false;
    }
  }

  async #restart(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      this.#render(await this.#session.command<RtcState>("reset_drift"));
      this.#message.textContent = "";
    } catch (err) {
      this.#fail(err);
    } finally {
      button.disabled = false;
    }
  }

  async #poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      this.#render(await this.#session.poll<RtcState>());
    } catch (err) {
      this.#fail(err);
    } finally {
      this.#polling = false;
    }
  }

  #render(state: RtcState): void {
    this.#clock.textContent = state.iso.replace("T", "  ").replace("Z", "");
    this.#status.set(state.identity ?? state.label, "ok");

    const ms = state.offsetS * 1000;
    const uncertainty = state.uncertaintyS * 1000;
    this.#offset.textContent =
      `${ms >= 0 ? "+" : "−"}${Math.abs(ms).toFixed(0)} ms against this computer ` +
      `(±${uncertainty.toFixed(0)} ms, the time the read itself takes)`;
    this.#offset.dataset.tone = Math.abs(ms) > 2000 ? "warn" : "ok";

    // The reasoning about what the drift figure is worth hangs off the offset
    // line rather than taking a paragraph of its own -- it is the same thought,
    // and it is long.
    const drift = describeDrift(state);
    this.#offset.title = drift.detail;
    this.#drift.textContent = drift.summary;
    this.#drift.hidden = drift.summary === "";
    this.#drift.title = drift.detail;
    this.#renderFlags(state.flags);
  }

  #renderFlags(flags: RtcFlag[]): void {
    this.#flags.replaceChildren();
    for (const flag of flags) {
      const value = el("dd", {}, [el("span", { text: flag.value })]);
      value.dataset.tone = flag.tone;
      if (flag.action) {
        // A flag you can do something about should say so where it is raised,
        // not leave you to find the button that clears it.
        const fix = el("button", { class: "inline", text: "Clear" });
        fix.addEventListener("click", () => void this.#act(flag.action!, fix));
        value.append(" ", fix);
      }
      this.#flags.append(el("dt", { text: flag.label }), value);
    }
  }

  async #act(command: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      this.#render(await this.#session.command<RtcState>(command));
      this.#message.textContent = "";
    } catch (err) {
      this.#fail(err);
    } finally {
      button.disabled = false;
    }
  }

  #fail(err: unknown): void {
    this.#status.set("Failed", "error");
    this.#message.textContent = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Say what the drift measurement is worth, not just what it is.
 *
 * A rate computed over ten seconds from a clock that counts hundredths can be
 * out by a thousand ppm purely from quantisation, so quoting it to one decimal
 * would be a lie told precisely. The summary is what shows; the detail is the
 * tooltip, because the reasoning is worth having but not worth a paragraph on
 * screen at all times.
 */
function describeDrift(state: RtcState): { summary: string; detail: string } {
  if (state.driftPpm === null || state.resolutionPpm === null || state.elapsedS < 2) {
    return {
      summary: "",
      detail: "A drift rate needs two readings some time apart. Leave it running.",
    };
  }

  const elapsed = formatDuration(state.elapsedS);
  const resolution = state.resolutionPpm;
  if (Math.abs(state.driftPpm) < resolution) {
    return {
      summary: "",
      detail:
        `No drift resolvable yet: ${elapsed} of observation resolves about ` +
        `±${resolution.toFixed(0)} ppm, and the measurement is inside that. ` +
        `Leave it running — the bound improves in proportion to the time.`,
    };
  }

  const perDay = (state.driftPpm * 86400) / 1e6;
  const digits = resolution < 1 ? 2 : 0;
  return {
    summary:
      `Drifting ${state.driftPpm > 0 ? "fast" : "slow"} by ` +
      `${Math.abs(state.driftPpm).toFixed(digits)} ppm — ` +
      `about ${Math.abs(perDay).toFixed(1)} s/day.`,
    detail:
      `${Math.abs(state.driftPpm).toFixed(digits)} ±${resolution.toFixed(digits)} ppm ` +
      `measured over ${elapsed}, which works out at ` +
      `${Math.abs((perDay * 365) / 60).toFixed(0)} min/year. The bound is what ` +
      `one tick of this part's resolution looks like over that long, and it ` +
      `improves in proportion to the time.`,
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${seconds.toFixed(0)} s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

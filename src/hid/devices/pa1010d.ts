import type { VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic Adafruit Mini GPS PA1010D for demo mode and tests.
 *
 * The real part streams NMEA over I2C and returns 0x0A padding whenever it has
 * nothing to say, which is exactly the behaviour adafruit_gps's byte-at-a-time
 * reader is written against. It starts without a fix and acquires satellites
 * over the first few seconds, so the GPS panel has something to actually show.
 */

const NEWLINE = 0x0a;
const SENTENCE_INTERVAL_MS = 1000;
const DEFAULT_ACQUIRE_MS = 6000;

export interface Pa1010dOptions {
  address?: number;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  /** How long to report "no fix" for. Tests pass 0 to skip the wait. */
  acquireMs?: number;
  now?: () => number;
}

export class VirtualPa1010d implements VirtualI2cDevice {
  readonly address: number;
  readonly name = "PA1010D GPS";

  readonly #latitude: number;
  readonly #longitude: number;
  readonly #altitude: number;
  readonly #acquireMs: number;
  readonly #now: () => number;
  readonly #start: number;
  #outbox: number[] = [];
  #inbox = "";
  #lastSentence = 0;
  /** PMTK commands the host has sent us, kept for tests and the demo log. */
  readonly commands: string[] = [];

  constructor(options: Pa1010dOptions = {}) {
    this.address = options.address ?? 0x10;
    this.#latitude = options.latitude ?? 37.7749;
    this.#longitude = options.longitude ?? -122.4194;
    this.#altitude = options.altitude ?? 16.4;
    this.#acquireMs = options.acquireMs ?? DEFAULT_ACQUIRE_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#start = this.#now();
  }

  write(data: Uint8Array): void {
    // adafruit_gps.send_command() emits "$", the body, "*", the checksum and
    // CRLF as five separate I2C writes, so commands have to be reassembled
    // rather than read out of a single transfer.
    this.#inbox += new TextDecoder().decode(data);
    let newline = this.#inbox.indexOf("\n");
    while (newline >= 0) {
      const line = this.#inbox.slice(0, newline).trim();
      this.#inbox = this.#inbox.slice(newline + 1);
      // Configuration is accepted and ignored: the emulated module always emits
      // the same GGA/RMC/GSA mix, which is what the panel parses.
      if (line.startsWith("$PMTK")) this.commands.push(line);
      newline = this.#inbox.indexOf("\n");
    }
  }

  read(length: number): Uint8Array {
    this.#fill();
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      // 0x0A padding is how the real part says "nothing buffered".
      out[i] = this.#outbox.shift() ?? NEWLINE;
    }
    return out;
  }

  /** Seconds since power-on, which is when the simulated fix starts drifting. */
  get elapsedMs(): number {
    return this.#now() - this.#start;
  }

  get hasFix(): boolean {
    return this.elapsedMs >= this.#acquireMs;
  }

  #fill(): void {
    if (this.#outbox.length > 0) return;
    const now = this.#now();
    // The first burst goes out immediately; after that, once per second like the
    // real module, with 0x0A padding in between.
    if (this.#lastSentence !== 0 && now - this.#lastSentence < SENTENCE_INTERVAL_MS) return;
    this.#lastSentence = now;

    const elapsed = this.elapsedMs;
    const fix = elapsed >= this.#acquireMs;
    // Climb from 0 to 11 satellites over the acquisition window, then hold.
    const satellites = fix ? Math.min(11, 4 + Math.floor((elapsed - this.#acquireMs) / 1500)) : 0;
    const hdop = fix ? Math.max(0.8, 3.2 - (elapsed - this.#acquireMs) / 4000) : 99.99;

    // A slow circular wander of a few metres, so the readout is visibly live.
    const drift = elapsed / 30000;
    const latitude = this.#latitude + Math.sin(drift) * 0.00004;
    const longitude = this.#longitude + Math.cos(drift) * 0.00005;

    const clock = new Date(this.#start + elapsed);
    for (const sentence of [
      gga(clock, latitude, longitude, fix, satellites, hdop, this.#altitude),
      rmc(clock, latitude, longitude, fix),
      gsa(fix, satellites, hdop),
    ]) {
      for (const code of sentence) this.#outbox.push(code);
    }
  }
}

// ------------------------------------------------------------------ sentences

function gga(
  clock: Date,
  latitude: number,
  longitude: number,
  fix: boolean,
  satellites: number,
  hdop: number,
  altitude: number,
): number[] {
  const body =
    `GPGGA,${utcTime(clock)},${degrees(latitude, 2)},${latitude >= 0 ? "N" : "S"},` +
    `${degrees(longitude, 3)},${longitude >= 0 ? "E" : "W"},${fix ? 1 : 0},` +
    `${String(satellites).padStart(2, "0")},${hdop.toFixed(2)},` +
    `${fix ? altitude.toFixed(1) : ""},M,${fix ? "-32.1" : ""},M,,`;
  return encode(body);
}

function rmc(clock: Date, latitude: number, longitude: number, fix: boolean): number[] {
  const body =
    `GPRMC,${utcTime(clock)},${fix ? "A" : "V"},${degrees(latitude, 2)},` +
    `${latitude >= 0 ? "N" : "S"},${degrees(longitude, 3)},${longitude >= 0 ? "E" : "W"},` +
    `${fix ? "0.14" : ""},${fix ? "148.2" : ""},${utcDate(clock)},,,${fix ? "A" : "N"}`;
  return encode(body);
}

function gsa(fix: boolean, satellites: number, hdop: number): number[] {
  const used = Array.from({ length: 12 }, (_, i) => (i < satellites ? String(i + 2) : "")).join(",");
  const body =
    `GPGSA,A,${fix ? 3 : 1},${used},` +
    `${fix ? (hdop + 0.9).toFixed(2) : "99.99"},${fix ? hdop.toFixed(2) : "99.99"},` +
    `${fix ? (hdop + 0.4).toFixed(2) : "99.99"}`;
  return encode(body);
}

/** Wrap an NMEA body in `$`, its XOR checksum, and CRLF. */
function encode(body: string): number[] {
  let checksum = 0;
  for (let i = 0; i < body.length; i++) checksum ^= body.charCodeAt(i);
  const sentence = `$${body}*${checksum.toString(16).toUpperCase().padStart(2, "0")}\r\n`;
  return [...sentence].map((char) => char.charCodeAt(0));
}

/** NMEA ddmm.mmmm (latitude) or dddmm.mmmm (longitude). */
function degrees(value: number, digits: number): string {
  const absolute = Math.abs(value);
  const whole = Math.floor(absolute);
  const minutes = (absolute - whole) * 60;
  return `${String(whole).padStart(digits, "0")}${minutes.toFixed(4).padStart(7, "0")}`;
}

function utcTime(clock: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${pad(clock.getUTCHours())}${pad(clock.getUTCMinutes())}${pad(clock.getUTCSeconds())}` +
    `.${String(clock.getUTCMilliseconds()).padStart(3, "0")}`
  );
}

function utcDate(clock: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(clock.getUTCDate())}${pad(clock.getUTCMonth() + 1)}${pad(clock.getUTCFullYear() % 100)}`;
}

import type { VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic AHT10/AHT20 for demo mode and tests.
 *
 * Faithful to the parts of the protocol adafruit_ahtx0 actually exercises: a
 * status byte with busy and calibrated flags, a soft reset, a calibrate command
 * and a triggered measurement returning six packed bytes. Anything the library
 * never reads is left alone rather than invented.
 *
 * It also models the thing that makes this sensor confusing in practice --
 * self-heating. A real AHT10 reads high for the first minute or two after
 * power-up, and its own die warms the humidity element, so both figures drift
 * before settling. Demo mode without that would show a rock-steady reading and
 * teach the wrong thing about the panel's trend plot.
 */

const CMD_CALIBRATE_AHT10 = 0xe1;
const CMD_CALIBRATE_AHT20 = 0xbe;
const CMD_TRIGGER = 0xac;
const CMD_SOFT_RESET = 0xba;

const STATUS_BUSY = 0x80;
const STATUS_CALIBRATED = 0x08;

/**
 * Status reads a conversion stays busy for.
 *
 * Counted rather than timed. adafruit_ahtx0 spins on `while status & BUSY` with
 * no timeout, so a busy flag that clears on a clock the test controls can hang
 * the library outright -- an emulator that can wedge its caller is not a useful
 * one. Counting guarantees progress and is deterministic besides. A real part
 * is busy about 80ms, which at the library's 10ms poll is roughly this many.
 */
const BUSY_READS = 8;
/** Time constant of the self-heating drift. */
const WARMUP_MS = 90_000;

export interface Aht10Options {
  address?: number;
  /** Ambient conditions the sensor is sitting in, once it has settled. */
  temperatureC?: number;
  relativeHumidity?: number;
  /** Degrees the die adds when first powered, decaying away as it settles. */
  selfHeatC?: number;
  now?: () => number;
}

export class VirtualAht10 implements VirtualI2cDevice {
  readonly address: number;
  readonly name = "AHT10 temperature & humidity";

  readonly #ambientC: number;
  readonly #ambientRh: number;
  readonly #selfHeatC: number;
  readonly #now: () => number;
  #start: number;
  #calibrated = false;
  #busyReads = 0;
  /** Set by a trigger, cleared by the six-byte read that collects it. */
  #measurement: number[] | null = null;
  /** Commands the host has sent, for tests. */
  readonly commands: number[] = [];

  constructor(options: Aht10Options = {}) {
    this.address = options.address ?? 0x38;
    this.#ambientC = options.temperatureC ?? 21.5;
    this.#ambientRh = options.relativeHumidity ?? 43;
    this.#selfHeatC = options.selfHeatC ?? 1.8;
    this.#now = options.now ?? (() => Date.now());
    this.#start = this.#now();
  }

  write(data: Uint8Array): void {
    const command = data[0];
    if (command === undefined) return;
    this.commands.push(command);

    switch (command) {
      case CMD_SOFT_RESET:
        this.#calibrated = false;
        this.#measurement = null;
        this.#busyReads = 0;
        this.#start = this.#now();
        return;
      case CMD_CALIBRATE_AHT10:
      case CMD_CALIBRATE_AHT20:
        this.#calibrated = true;
        return;
      case CMD_TRIGGER:
        this.#busyReads = BUSY_READS;
        // Sampled at trigger time, as the real part does: the conversion is of
        // the conditions when it started, not when it was collected.
        this.#measurement = this.#sample();
        return;
      default:
        // Unknown command. A real part ignores it; so do we, rather than
        // inventing an error the library has no path for.
        return;
    }
  }

  read(length: number): Uint8Array {
    const busy = this.#busyReads > 0;
    if (busy) this.#busyReads--;
    const status = (busy ? STATUS_BUSY : 0) | (this.#calibrated ? STATUS_CALIBRATED : 0);

    // A one-byte read is the status poll; six bytes collects the measurement.
    if (length === 1) return Uint8Array.from([status]);

    const out = new Uint8Array(length);
    out[0] = status;
    const measurement = this.#measurement ?? this.#sample();
    for (let i = 0; i < Math.min(5, length - 1); i++) out[i + 1] = measurement[i] ?? 0;
    return out;
  }

  /** Pack the current conditions the way the datasheet lays the six bytes out. */
  #sample(): number[] {
    const elapsed = this.#now() - this.#start;
    // Exponential decay towards ambient, which is what a warming die looks like.
    const excess = this.#selfHeatC * Math.exp(-elapsed / WARMUP_MS);
    const temperatureC = this.#ambientC + excess;
    // Warmer air at fixed absolute humidity reads lower relative humidity, so
    // the two drift in opposite directions -- worth reproducing, since seeing
    // that on the plot is how you recognise self-heating rather than weather.
    const relativeHumidity = this.#ambientRh - excess * 2.2;

    // Both fields are 20 bits, and full scale is 0xfffff rather than 0x100000 --
    // rounding 100 % RH straight up produces a 21-bit value whose top bit falls
    // off the end, so saturated air would read as bone dry.
    const rawHumidity = clamp20((relativeHumidity / 100) * 0x100000);
    const rawTemperature = clamp20(((temperatureC + 50) / 200) * 0x100000);

    return [
      (rawHumidity >> 12) & 0xff,
      (rawHumidity >> 4) & 0xff,
      ((rawHumidity << 4) & 0xf0) | ((rawTemperature >> 16) & 0x0f),
      (rawTemperature >> 8) & 0xff,
      rawTemperature & 0xff,
    ];
  }
}

function clamp20(value: number): number {
  return Math.max(0, Math.min(0xfffff, Math.round(value)));
}

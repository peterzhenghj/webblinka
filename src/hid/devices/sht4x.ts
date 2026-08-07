import { withCrcs } from "./crc8.ts";
import type { VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic Sensirion SHT4x.
 *
 * Command in, six bytes out: two of temperature, its CRC, two of humidity, its
 * CRC. The library checks both checksums and raises on a mismatch, so this has
 * to compute them properly -- a stub returning zeros would fail every read, and
 * one returning a fixed byte would pass only by luck.
 *
 * It models the heater, because the heater is the point of the part with the
 * PTFE cap: a pulse drives condensation off the filter and resets the polymer's
 * creep, at the cost of warming the die enough to ruin the temperature reading
 * for a few seconds. Both halves of that are reproduced.
 */

const CMD_READ_SERIAL = 0x89;
const CMD_SOFT_RESET = 0x94;

/** No-heat measurement commands, from the datasheet. */
const MEASURE_COMMANDS = new Set([0xfd, 0xf6, 0xe0]);
/** Heater pulses: 200/110/20 mW for one second or a tenth. */
const HEAT_COMMANDS = new Map<number, { watts: number; seconds: number }>([
  [0x39, { watts: 0.2, seconds: 1 }],
  [0x32, { watts: 0.2, seconds: 0.1 }],
  [0x2f, { watts: 0.11, seconds: 1 }],
  [0x24, { watts: 0.11, seconds: 0.1 }],
  [0x1e, { watts: 0.02, seconds: 1 }],
  [0x15, { watts: 0.02, seconds: 0.1 }],
]);

/** Degrees the die rises per watt-second of heating. */
const HEAT_RISE_C_PER_JOULE = 9;
/** Time constant of the die cooling back down. */
const COOL_MS = 6000;

export interface Sht4xOptions {
  address?: number;
  temperatureC?: number;
  relativeHumidity?: number;
  serial?: number;
  now?: () => number;
}

export class VirtualSht4x implements VirtualI2cDevice {
  readonly address: number;
  readonly name = "SHT4x temperature & humidity";

  readonly #serial: number;
  readonly #now: () => number;
  ambientC: number;
  ambientRh: number;
  /** Commands the host has sent, for tests. */
  readonly commands: number[] = [];

  #pending: Uint8Array | null = null;
  #heatedAt: number | null = null;
  #heatRiseC = 0;

  constructor(options: Sht4xOptions = {}) {
    this.address = options.address ?? 0x44;
    this.ambientC = options.temperatureC ?? 21.5;
    this.ambientRh = options.relativeHumidity ?? 44;
    this.#serial = options.serial ?? 0x0a1b2c3d;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Degrees the die is currently above ambient, decaying after a pulse. */
  get heatRiseC(): number {
    if (this.#heatedAt === null) return 0;
    return this.#heatRiseC * Math.exp(-(this.#now() - this.#heatedAt) / COOL_MS);
  }

  write(data: Uint8Array): void {
    const command = data[0];
    if (command === undefined) return; // address probe
    this.commands.push(command);

    if (command === CMD_READ_SERIAL) {
      this.#pending = withCrcs([
        (this.#serial >> 24) & 0xff,
        (this.#serial >> 16) & 0xff,
        (this.#serial >> 8) & 0xff,
        this.#serial & 0xff,
      ]);
      return;
    }
    if (command === CMD_SOFT_RESET) {
      this.#heatedAt = null;
      this.#heatRiseC = 0;
      this.#pending = null;
      return;
    }

    const pulse = HEAT_COMMANDS.get(command);
    if (pulse) {
      // The heater runs during a measurement, so the reading that comes back
      // is of a warm die -- which is exactly why the driver throws it away.
      this.#heatRiseC = this.heatRiseC + pulse.watts * pulse.seconds * HEAT_RISE_C_PER_JOULE;
      this.#heatedAt = this.#now();
    }
    if (pulse || MEASURE_COMMANDS.has(command)) {
      this.#pending = this.#measure();
    }
  }

  read(length: number): Uint8Array {
    const out = new Uint8Array(length);
    const pending = this.#pending ?? this.#measure();
    out.set(pending.subarray(0, length));
    return out;
  }

  #measure(): Uint8Array {
    const rise = this.heatRiseC;
    const temperature = this.ambientC + rise;
    // Warmer air holds more water, so heating the die drops the relative
    // reading even though the absolute humidity has not moved. That is the
    // effect the heater is exploiting, and the panel's trend shows it.
    const humidity = Math.max(0, Math.min(100, this.ambientRh - rise * 2.4));

    // Datasheet transfer functions, inverted.
    const rawT = Math.round(((temperature + 45) / 175) * 65535);
    const rawH = Math.round(((humidity + 6) / 125) * 65535);
    return withCrcs([
      (rawT >> 8) & 0xff,
      rawT & 0xff,
      (rawH >> 8) & 0xff,
      rawH & 0xff,
    ]);
  }
}

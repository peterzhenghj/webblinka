import { withCrcs } from "./crc8.ts";
import type { VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic TI HDC302x.
 *
 * Sixteen-bit commands rather than the SHT4x's eight, and a latching heater
 * rather than timed pulses -- which is the behaviour worth modelling, because a
 * driver that forgets to switch it off leaves the die warming indefinitely and
 * every subsequent reading measuring the heater.
 */

const CMD_TRIGGER = 0x2400; // trigger-on-demand, low repeatability variants share the high byte
const CMD_STATUS = 0xf32d;
const CMD_MANUFACTURER = 0x3781;
const CMD_NIST_FIRST = 0x3683;
const CMD_HEATER_ENABLE = 0x306d;
const CMD_HEATER_DISABLE = 0x3066;
const CMD_HEATER_CONFIG = 0x306e;

const HEATER_ON_BIT = 1 << 13;

export interface Hdc302xOptions {
  address?: number;
  temperatureC?: number;
  relativeHumidity?: number;
  manufacturerId?: number;
  now?: () => number;
}

export class VirtualHdc302x implements VirtualI2cDevice {
  readonly address: number;
  readonly name = "HDC302x temperature & humidity";

  readonly #manufacturerId: number;
  readonly #now: () => number;
  ambientC: number;
  ambientRh: number;
  /** Commands the host has sent, for tests. */
  readonly commands: number[] = [];

  #pending: Uint8Array | null = null;
  #heaterOn = false;
  #heaterSince: number | null = null;

  constructor(options: Hdc302xOptions = {}) {
    this.address = options.address ?? 0x44;
    this.ambientC = options.temperatureC ?? 22;
    this.ambientRh = options.relativeHumidity ?? 41;
    this.#manufacturerId = options.manufacturerId ?? 0x3000;
    this.#now = options.now ?? (() => Date.now());
  }

  get heaterOn(): boolean {
    return this.#heaterOn;
  }

  /** Degrees above ambient, rising while the heater is on and settling after. */
  get heatRiseC(): number {
    if (this.#heaterSince === null) return 0;
    const seconds = (this.#now() - this.#heaterSince) / 1000;
    // Approaches a steady rise rather than climbing forever, which is what a
    // latched heater on a small die actually does.
    const settled = 3.5 * (1 - Math.exp(-seconds / 8));
    return this.#heaterOn ? settled : settled * Math.exp(-seconds / 8);
  }

  write(data: Uint8Array): void {
    if (data.length < 2) return; // address probe
    const command = ((data[0] ?? 0) << 8) | (data[1] ?? 0);
    this.commands.push(command);

    switch (command) {
      case CMD_STATUS:
        this.#pending = withCrcs([this.#heaterOn ? HEATER_ON_BIT >> 8 : 0, 0]);
        return;
      case CMD_MANUFACTURER:
        this.#pending = withCrcs([(this.#manufacturerId >> 8) & 0xff, this.#manufacturerId & 0xff]);
        return;
      case CMD_HEATER_ENABLE:
        this.#heaterOn = true;
        this.#heaterSince = this.#now();
        return;
      case CMD_HEATER_DISABLE:
        this.#heaterOn = false;
        this.#heaterSince = this.#now();
        return;
      case CMD_HEATER_CONFIG:
        return; // the power word follows; the level itself changes nothing here
      default:
        break;
    }

    if (command >= CMD_NIST_FIRST && command <= CMD_NIST_FIRST + 2) {
      this.#pending = withCrcs([0xab, 0xcd]);
      return;
    }
    // Everything else in the 0x24xx family is a trigger-on-demand measurement.
    if ((command & 0xff00) === CMD_TRIGGER || (command & 0xff00) === 0x2400) {
      this.#pending = this.#measure();
    }
  }

  read(length: number): Uint8Array {
    const out = new Uint8Array(length);
    out.set((this.#pending ?? this.#measure()).subarray(0, length));
    return out;
  }

  #measure(): Uint8Array {
    const rise = this.heatRiseC;
    const temperature = this.ambientC + rise;
    const humidity = Math.max(0, Math.min(100, this.ambientRh - rise * 2.2));
    // TI's transfer functions, inverted. Note they differ from Sensirion's --
    // same idea, different constants, and swapping them would be a plausible
    // few degrees out rather than an obvious failure.
    const rawT = Math.round(((temperature + 45) / 175) * 65535);
    const rawH = Math.round((humidity / 100) * 65535);
    return withCrcs([(rawT >> 8) & 0xff, rawT & 0xff, (rawH >> 8) & 0xff, rawH & 0xff]);
  }
}

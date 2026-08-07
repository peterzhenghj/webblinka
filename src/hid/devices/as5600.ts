import type { VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic AS5600 magnetic encoder.
 *
 * A register file with a shaft behind it, and -- more usefully -- a magnet that
 * can be put at the wrong distance. The angle registers hand back a plausible
 * number in every case, including with no magnet at all, which is exactly the
 * failure the panel exists to catch, so the emulator has to be able to produce
 * it: `gap` drives the automatic gain and the status bits the same way moving a
 * real magnet would.
 */

const REG_ZPOS_H = 0x01;
const REG_STATUS = 0x0b;
const REG_RAWANGLE_H = 0x0c;
const REG_ANGLE_H = 0x0e;
const REG_AGC = 0x1a;
const REG_MAGNITUDE_H = 0x1b;
const REGISTER_COUNT = 0x100;

const STATUS_MH = 1 << 3; // gain bottomed out: magnet too strong or too close
const STATUS_ML = 1 << 4; // gain maxed out: too weak or too far
const STATUS_MD = 1 << 5; // a magnet is there at all

const FULL_SCALE = 4096;

export interface As5600Options {
  address?: number;
  /** Shaft angle in degrees. Wraps freely; turn counting is the driver's job. */
  degrees?: number;
  /**
   * How far the magnet sits from the die, 0 (touching) to 1 (gone). The middle
   * of the range is a good gap; the ends saturate the gain and raise ML or MH.
   */
  gap?: number;
  /** No magnet at all. The angle registers still return something. */
  magnetAbsent?: boolean;
}

export class VirtualAs5600 implements VirtualI2cDevice {
  readonly address: number;
  readonly name = "AS5600 magnetic encoder";

  readonly #registers = new Uint8Array(REGISTER_COUNT);
  degrees: number;
  gap: number;
  magnetAbsent: boolean;
  #pointer = 0;

  constructor(options: As5600Options = {}) {
    this.address = options.address ?? 0x36;
    this.degrees = options.degrees ?? 0;
    this.gap = options.gap ?? 0.5;
    this.magnetAbsent = options.magnetAbsent ?? false;
  }

  /** Turn the shaft, in degrees. Accepts any value and wraps. */
  rotate(by: number): void {
    this.degrees = (((this.degrees + by) % 360) + 360) % 360;
  }

  write(data: Uint8Array): void {
    const register = data[0];
    if (register === undefined) return; // address probe
    const payload = data.subarray(1);
    if (payload.length === 0) {
      this.#pointer = register;
      return;
    }
    for (let i = 0; i < payload.length; i++) {
      this.#registers[(register + i) % REGISTER_COUNT] = payload[i] ?? 0;
    }
    this.#pointer = (register + payload.length) % REGISTER_COUNT;
  }

  read(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = this.#value((this.#pointer + i) % REGISTER_COUNT);
    }
    this.#pointer = (this.#pointer + length) % REGISTER_COUNT;
    return out;
  }

  #value(at: number): number {
    const raw = Math.round((this.degrees / 360) * FULL_SCALE) % FULL_SCALE;
    if (at === REG_RAWANGLE_H) return (raw >> 8) & 0x0f;
    if (at === REG_RAWANGLE_H + 1) return raw & 0xff;
    if (at === REG_ANGLE_H || at === REG_ANGLE_H + 1) {
      // The scaled angle is the raw one shifted by ZPOS, which is the whole
      // point of having both -- one is the shaft, the other is your datum.
      const zero = ((this.#registers[REG_ZPOS_H] ?? 0) << 8) | (this.#registers[REG_ZPOS_H + 1] ?? 0);
      const scaled = (raw - (zero & 0x0fff) + FULL_SCALE) % FULL_SCALE;
      return at === REG_ANGLE_H ? (scaled >> 8) & 0x0f : scaled & 0xff;
    }
    if (at === REG_STATUS) return this.#status();
    if (at === REG_AGC) return this.#agc();
    if (at === REG_MAGNITUDE_H) return (this.#magnitude() >> 8) & 0x0f;
    if (at === REG_MAGNITUDE_H + 1) return this.#magnitude() & 0xff;
    return this.#registers[at] ?? 0;
  }

  /**
   * Automatic gain. The chip winds it up as the field weakens, so it rises
   * with the gap -- which is what makes it a proxy for magnet distance.
   */
  #agc(): number {
    if (this.magnetAbsent) return 255;
    return Math.max(0, Math.min(255, Math.round(this.gap * 255)));
  }

  #magnitude(): number {
    if (this.magnetAbsent) return 0;
    return Math.round((1 - this.gap) * FULL_SCALE);
  }

  #status(): number {
    if (this.magnetAbsent) return STATUS_ML; // gain maxed, nothing found
    let status = STATUS_MD;
    if (this.#agc() >= 255) status |= STATUS_ML;
    if (this.#agc() <= 0) status |= STATUS_MH;
    return status;
  }
}

import { NackError, type VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic RV-1805 real-time clock.
 *
 * A register file with a clock running behind it: reads of the time registers
 * return whatever the simulated clock says now, in BCD, rather than a frozen
 * snapshot. That is what makes it useful for the panel's drift measurement --
 * `driftPpm` makes the simulated clock run fast or slow by a chosen amount, so
 * the whole measurement path can be tested against a known answer instead of
 * against whatever a real crystal happens to be doing today.
 */

const HUNDREDTHS = 0x00;
const STATUS = 0x0f;
const CTRL1 = 0x10;
const OSC_STATUS = 0x1d;
const ID0 = 0x28;
const REGISTER_COUNT = 0x40;

/** Register 0x28 reads this on a genuine part. */
const PART_NUMBER = 0x18;

export interface Rv1805Options {
  address?: number;
  /** Where the simulated clock starts, as a unix timestamp in seconds. */
  epoch?: number;
  /**
   * Parts per million the simulated clock runs fast. A real RV-1805 is within
   * a couple; setting this larger makes a drift measurable in a short test.
   */
  driftPpm?: number;
  /** Report the internal RC oscillator rather than the crystal. */
  onRcOscillator?: boolean;
  oscillatorFault?: boolean;
  onBackupPower?: boolean;
  stopped?: boolean;
  now?: () => number;
}

export class VirtualRv1805 implements VirtualI2cDevice {
  readonly address: number;
  readonly name = "RV-1805 RTC";

  readonly #registers = new Uint8Array(REGISTER_COUNT);
  readonly #now: () => number;
  readonly #driftPpm: number;
  /** Host milliseconds when the clock was last set. */
  #setAtHost: number;
  /** What the clock read at that moment, in seconds. */
  #setToDevice: number;

  constructor(options: Rv1805Options = {}) {
    this.address = options.address ?? 0x69;
    this.#now = options.now ?? (() => Date.now());
    this.#driftPpm = options.driftPpm ?? 0;
    this.#setAtHost = this.#now();
    this.#setToDevice = options.epoch ?? this.#setAtHost / 1000;

    this.#registers[ID0] = PART_NUMBER;
    if (options.onRcOscillator) this.#registers[OSC_STATUS]! |= 1 << 4;
    if (options.oscillatorFault) this.#registers[OSC_STATUS]! |= 1 << 1;
    if (options.onBackupPower) this.#registers[STATUS]! |= 1 << 6;
    if (options.stopped) this.#registers[CTRL1]! |= 1 << 7;
  }

  /** Whether the latched oscillator-failure bit is set. For tests. */
  get oscillatorFault(): boolean {
    return ((this.#registers[OSC_STATUS] ?? 0) & (1 << 1)) !== 0;
  }

  /** The simulated clock, in unix seconds. */
  get deviceUnix(): number {
    const elapsed = (this.#now() - this.#setAtHost) / 1000;
    return this.#setToDevice + elapsed * (1 + this.#driftPpm / 1e6);
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
      const at = (register + i) % REGISTER_COUNT;
      this.#registers[at] = payload[i] ?? 0;
    }
    // A write covering the time registers sets the clock.
    if (register <= HUNDREDTHS && register + payload.length > HUNDREDTHS + 6) {
      this.#adopt();
    }
    this.#pointer = (register + payload.length) % REGISTER_COUNT;
  }

  read(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const at = (this.#pointer + i) % REGISTER_COUNT;
      out[i] = at <= 0x07 ? this.#clockRegister(at) : (this.#registers[at] ?? 0);
    }
    this.#pointer = (this.#pointer + length) % REGISTER_COUNT;
    return out;
  }

  #pointer = 0;

  /** Time registers are generated from the running clock, not stored. */
  #clockRegister(at: number): number {
    const seconds = this.deviceUnix;
    const date = new Date(Math.floor(seconds) * 1000);
    const hundredths = Math.floor((seconds % 1) * 100);
    switch (at) {
      case 0x00:
        return toBcd(hundredths);
      case 0x01:
        return toBcd(date.getUTCSeconds());
      case 0x02:
        return toBcd(date.getUTCMinutes());
      case 0x03:
        return toBcd(date.getUTCHours());
      case 0x04:
        return toBcd(date.getUTCDate());
      case 0x05:
        return toBcd(date.getUTCMonth() + 1);
      case 0x06:
        return toBcd(date.getUTCFullYear() % 100);
      case 0x07:
        return toBcd(date.getUTCDay());
      default:
        return 0;
    }
  }

  /** Adopt the calendar just written into the registers as the new clock. */
  #adopt(): void {
    const r = this.#registers;
    const when = Date.UTC(
      2000 + fromBcd(r[0x06] ?? 0),
      fromBcd(r[0x05] ?? 1) - 1,
      fromBcd(r[0x04] ?? 1),
      fromBcd((r[0x03] ?? 0) & 0x3f),
      fromBcd(r[0x02] ?? 0),
      fromBcd(r[0x01] ?? 0),
      fromBcd(r[0x00] ?? 0) * 10,
    );
    this.#setAtHost = this.#now();
    this.#setToDevice = when / 1000;
  }
}

/** Something else living at 0x69, for the wrong-part-here case. */
export class VirtualWrongPart implements VirtualI2cDevice {
  readonly name = "something else entirely";
  readonly address: number;

  constructor(address = 0x69) {
    this.address = address;
  }

  write(): void {}

  read(length: number): Uint8Array {
    // Anything but 0x18 at register 0x28. An MPU-6050 at this address reports
    // 0x68 from its own WHO_AM_I, which is the realistic confusion.
    return new Uint8Array(length).fill(0x68);
  }
}

/** A part that will not answer at all, so the probe fails cleanly. */
export class VirtualSilentPart implements VirtualI2cDevice {
  readonly name = "silent";
  readonly address: number;

  constructor(address = 0x69) {
    this.address = address;
  }

  write(): void {
    throw new NackError("not listening");
  }

  read(): Uint8Array {
    throw new NackError("not listening");
  }
}

function toBcd(value: number): number {
  return ((Math.floor(value / 10) % 10) << 4) | (value % 10);
}

function fromBcd(value: number): number {
  return (value >> 4) * 10 + (value & 0x0f);
}

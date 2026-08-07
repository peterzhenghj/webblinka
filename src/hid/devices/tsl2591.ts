import type { VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic TSL2591.
 *
 * Two things make this worth emulating rather than stubbing.
 *
 * It **saturates**. Counts are computed from the light and the current gain and
 * integration time, then clipped at full scale exactly as the ADC would, so
 * pointing it at a bright enough `lux` produces the overflow the stock library
 * raises on -- which is the failure the driver exists to handle, and which no
 * fixed-value stub can produce.
 *
 * Its settings are **not instant**. The ADC free-runs; a gain written now does
 * not affect the count until the integration in flight has finished. So a read
 * taken straight after a change returns counts from the old setting, which the
 * driver would otherwise scale by the new one and report as a real measurement
 * off by the ratio between them. The emulator holds the previous settings for
 * one integration period to keep that trap reproducible.
 */

const COMMAND_BIT = 0xa0;
const SPECIAL_BIT = 0xe0;

const REG_ENABLE = 0x00;
const REG_CONTROL = 0x01;
const REG_DEVICE_ID = 0x12;
const REG_CHAN0_LOW = 0x14;
const REG_CHAN1_LOW = 0x16;
const REGISTER_COUNT = 0x20;

/** The one value the library checks before it will talk to the part. */
const DEVICE_ID = 0x50;

const ENABLE_POWERON = 0x01;

const GAINS: Record<number, number> = { 0x00: 1, 0x10: 25, 0x20: 428, 0x30: 9876 };

const MAX_COUNT = 65535;
/** At the shortest integration the counter stops here, not at 65535. */
const MAX_COUNT_100MS = 36863;

const LUX_DF = 408;
const LUX_COEFB = 1.64;
const LUX_COEFC = 0.59;
const LUX_COEFD = 0.86;

export interface Tsl2591Options {
  address?: number;
  /** Illuminance falling on the part, in lux. Drives both channels. */
  lux?: number;
  /**
   * How much of the full-spectrum channel is infrared, 0 to about 0.6. A
   * property of the light source rather than its brightness: near zero for a
   * white LED, around a half for incandescent.
   */
  infraredFraction?: number;
  now?: () => number;
}

export class VirtualTsl2591 implements VirtualI2cDevice {
  readonly address: number;
  readonly name = "TSL2591 light sensor";

  lux: number;
  infraredFraction: number;

  readonly #registers = new Uint8Array(REGISTER_COUNT);
  readonly #now: () => number;
  #pointer = REG_DEVICE_ID;
  /** How many times the host has fetched a luminosity channel, for tests. */
  channelReads = 0;
  /** The settings the in-flight integration actually started under. */
  #inFlight = { gain: 0x10, integration: 0 };
  #changedAt: number;

  constructor(options: Tsl2591Options = {}) {
    this.address = options.address ?? 0x29;
    this.lux = options.lux ?? 120;
    this.infraredFraction = options.infraredFraction ?? 0.25;
    this.#now = options.now ?? (() => Date.now());
    this.#changedAt = this.#now();
    this.#registers[REG_DEVICE_ID] = DEVICE_ID;
    this.#registers[REG_CONTROL] = 0x10; // the library's own default: 25x, 100 ms
  }

  /** Whether the part is powered up and integrating, for tests. */
  get enabled(): boolean {
    return ((this.#registers[REG_ENABLE] ?? 0) & ENABLE_POWERON) !== 0;
  }

  get gain(): number {
    return (this.#registers[REG_CONTROL] ?? 0) & 0b00110000;
  }

  get integration(): number {
    return (this.#registers[REG_CONTROL] ?? 0) & 0b00000111;
  }

  write(data: Uint8Array): void {
    const command = data[0];
    if (command === undefined) return; // address probe
    // A special-function command carries no register and expects no reply.
    if ((command & SPECIAL_BIT) === SPECIAL_BIT) return;
    if ((command & COMMAND_BIT) !== COMMAND_BIT) return;

    const register = command & 0x1f;
    const payload = data.subarray(1);
    if (payload.length === 0) {
      this.#pointer = register;
      return;
    }
    if (register === REG_CONTROL) this.#startIntegration();
    for (let i = 0; i < payload.length; i++) {
      this.#registers[(register + i) % REGISTER_COUNT] = payload[i] ?? 0;
    }
    this.#pointer = register;
  }

  read(length: number): Uint8Array {
    if (this.#pointer === REG_CHAN0_LOW || this.#pointer === REG_CHAN1_LOW) this.channelReads++;
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = this.#value((this.#pointer + i) % REGISTER_COUNT);
    }
    return out;
  }

  /** Full scale for whatever integration time the reading was taken under. */
  fullScaleFor(integration: number): number {
    return integration === 0 ? MAX_COUNT_100MS : MAX_COUNT;
  }

  #value(at: number): number {
    const { gain, integration } = this.#effective();
    if (at === REG_CHAN0_LOW || at === REG_CHAN0_LOW + 1) {
      const channel0 = this.#channel0(gain, integration);
      return at === REG_CHAN0_LOW ? channel0 & 0xff : (channel0 >> 8) & 0xff;
    }
    if (at === REG_CHAN1_LOW || at === REG_CHAN1_LOW + 1) {
      const channel1 = this.#channel1(gain, integration);
      return at === REG_CHAN1_LOW ? channel1 & 0xff : (channel1 >> 8) & 0xff;
    }
    return this.#registers[at] ?? 0;
  }

  /**
   * The settings the count on offer was actually taken under -- the previous
   * ones until an integration period has passed since they were changed.
   */
  #effective(): { gain: number; integration: number } {
    const elapsed = this.#now() - this.#changedAt;
    const settled = elapsed >= (this.#inFlight.integration * 100 + 100);
    return settled ? { gain: this.gain, integration: this.integration } : this.#inFlight;
  }

  #startIntegration(): void {
    this.#inFlight = { gain: this.gain, integration: this.integration };
    this.#changedAt = this.#now();
  }

  /**
   * Invert the lux equation to get the count this light would produce.
   *
   * The driver runs it forwards, so a round trip through both has to land back
   * on the lux this was given -- which is the property the tests assert, and
   * would not hold against counts picked to look plausible.
   */
  #channel0(gain: number, integration: number): number {
    return this.#clip(this.#photocurrent(gain, integration), integration);
  }

  #channel1(gain: number, integration: number): number {
    // Off the *unclipped* full-spectrum figure: the two ADCs saturate
    // independently, so in bright light channel 0 pins first and the ratio
    // between the two stops meaning anything. Deriving IR from an already
    // clipped channel 0 would keep the ratio intact through saturation and
    // hide that.
    return this.#clip(
      Math.round(this.#photocurrent(gain, integration) * this.infraredFraction),
      integration,
    );
  }

  /** The count this light would produce with no ceiling in the way. */
  #photocurrent(gain: number, integration: number): number {
    const countsPerLux = ((integration * 100 + 100) * (GAINS[gain] ?? 1)) / LUX_DF;
    const f = this.infraredFraction;
    // The larger of the lux equation's two branches is the one the driver will
    // take, so it is the one to invert.
    const coefficient = Math.max(1 - LUX_COEFB * f, LUX_COEFC - LUX_COEFD * f);
    if (coefficient <= 0) return MAX_COUNT;
    return Math.round((this.lux * countsPerLux) / coefficient);
  }

  #clip(count: number, integration: number): number {
    return Math.max(0, Math.min(this.fullScaleFor(integration), count));
  }
}

import type { VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic AS7341 spectral sensor.
 *
 * The part has eleven photodiodes and only six ADCs, so the library routes them
 * through the chip's SMUX in two passes: F1-F4 with clear and NIR, then F5-F8
 * with clear and NIR. Which pass is in effect decides what CH0-CH5 mean, and
 * getting that wrong would silently relabel the whole spectrum -- so the bank is
 * *derived* from the SMUX RAM the library actually wrote rather than toggled on
 * each configuration. SMUX RAM slot 1 routes F1's left photodiode: connected in
 * the low pass, disabled in the high one.
 *
 * Counts scale with gain and integration time and clip at full scale, so the
 * panel's normalisation and its saturation warning both have something real to
 * work against.
 */

const REG_ENABLE = 0x80;
const REG_ATIME = 0x81;
const REG_WHOAMI = 0x92;
const REG_CH0_DATA_L = 0x95;
const REG_STATUS2 = 0xa3;
const REG_CFG1 = 0xaa;
const REG_ASTEP_L = 0xca;
const REGISTER_COUNT = 0x100;

/** WHOAMI holds the device id in bits 2-7. */
const DEVICE_ID = 0b001001;

const ENABLE_SMUX = 1 << 4;
const STATUS2_AVALID = 1 << 6;

/** SMUX RAM slot that routes F1's left photodiode. Nonzero only in the low pass. */
const SMUX_SLOT_F1L = 0x01;

const STEP_US = 2.78;
const ADC_MAX = 65535;

/** Relative response of F1-F8, clear and NIR under some ordinary indoor light. */
const DEFAULT_SPECTRUM = [0.22, 0.35, 0.52, 0.74, 0.93, 0.86, 0.61, 0.42, 1.0, 0.31];

export interface As7341Options {
  address?: number;
  /**
   * Per-channel relative irradiance: F1..F8 then clear and NIR. Scaled by gain
   * and integration time into counts, so the shape is the light and the
   * magnitude is the settings.
   */
  spectrum?: number[];
  /** Counts per unit of (relative irradiance x gain x milliseconds). */
  responsivity?: number;
}

export class VirtualAs7341 implements VirtualI2cDevice {
  readonly address: number;
  readonly name = "AS7341 spectral sensor";

  readonly #registers = new Uint8Array(REGISTER_COUNT);
  readonly #responsivity: number;
  spectrum: number[];
  #pointer = 0;

  constructor(options: As7341Options = {}) {
    this.address = options.address ?? 0x39;
    this.spectrum = options.spectrum ?? [...DEFAULT_SPECTRUM];
    this.#responsivity = options.responsivity ?? 0.9;
    this.#registers[REG_WHOAMI] = DEVICE_ID << 2;
  }

  /** Which SMUX pass the library last committed. */
  get lowBank(): boolean {
    return ((this.#registers[SMUX_SLOT_F1L] ?? 0) & 0x0f) !== 0;
  }

  get gain(): number {
    return 0.5 * 2 ** (this.#registers[REG_CFG1] ?? 0);
  }

  get integrationMs(): number {
    const atime = this.#registers[REG_ATIME] ?? 0;
    const astep = (this.#registers[REG_ASTEP_L] ?? 0) | ((this.#registers[REG_ASTEP_L + 1] ?? 0) << 8);
    return ((atime + 1) * (astep + 1) * STEP_US) / 1000;
  }

  get fullScale(): number {
    const atime = this.#registers[REG_ATIME] ?? 0;
    const astep = (this.#registers[REG_ASTEP_L] ?? 0) | ((this.#registers[REG_ASTEP_L + 1] ?? 0) << 8);
    return Math.min(ADC_MAX, (atime + 1) * (astep + 1));
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
    if (at === REG_ENABLE) {
      // The SMUX enable bit is self-clearing: the library sets it and then
      // waits for the chip to report the command finished.
      const enable = this.#registers[REG_ENABLE] ?? 0;
      this.#registers[REG_ENABLE] = enable & ~ENABLE_SMUX;
      return enable & ~ENABLE_SMUX;
    }
    if (at === REG_STATUS2) {
      // Data is ready as soon as a measurement is enabled. A real part takes
      // an integration time to get there; the library polls for this bit, and
      // making it wait would only add latency to every test.
      return (this.#registers[REG_STATUS2] ?? 0) | STATUS2_AVALID;
    }
    if (at >= REG_CH0_DATA_L && at < REG_CH0_DATA_L + 12) {
      const offset = at - REG_CH0_DATA_L;
      const counts = this.#channel(offset >> 1);
      return offset % 2 === 0 ? counts & 0xff : (counts >> 8) & 0xff;
    }
    return this.#registers[at] ?? 0;
  }

  /**
   * ADC channel to counts, through whichever SMUX pass is loaded.
   *
   * Both passes put clear on ADC4 and NIR on ADC5, which is why those two can
   * be read without caring which pass ran.
   */
  #channel(adc: number): number {
    if (adc === 4) return this.#counts(8); // clear
    if (adc === 5) return this.#counts(9); // NIR
    return this.#counts((this.lowBank ? 0 : 4) + adc);
  }

  #counts(channel: number): number {
    const irradiance = this.spectrum[channel] ?? 0;
    const raw = irradiance * this.gain * this.integrationMs * this.#responsivity;
    // Clipping is the point: a saturated channel reports full scale and the
    // panel has to notice, because the number looks perfectly reasonable.
    return Math.max(0, Math.min(this.fullScale, Math.round(raw)));
  }
}

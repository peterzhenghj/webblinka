/**
 * A device declining to answer: it is busy, write-protected, or otherwise not
 * acknowledging its address right now.
 *
 * Its own type rather than a bare Error so the bus can tell a modelled refusal
 * from a bug in the emulator. Catching everything would turn a genuine crash
 * into a plausible-looking NACK, and a test would pass on it.
 */
export class NackError extends Error {
  constructor(reason: string) {
    super(`NACK: ${reason}`);
    this.name = "NackError";
  }
}

/** A peripheral hanging off the emulated MCP2221's I2C bus. */
export interface VirtualI2cDevice {
  /** Base address. Where its A-pins put it. */
  readonly address: number;
  /**
   * Every address it answers on, when that is more than one.
   *
   * Larger EEPROMs than their word address can reach borrow the low bits of
   * the I2C address as high bits of the memory address, so a 24C16 answers on
   * all eight of 0x50-0x57 and leaves no A-pin free. Defaults to just
   * `address`, which is what every ordinary part wants.
   */
  readonly addresses?: readonly number[];
  /** Human-readable name, shown in demo mode. */
  readonly name: string;
  /** Master write. `address` is which of its addresses was selected. */
  write(data: Uint8Array, address: number): void;
  /** Master read of exactly `length` bytes, from the selected address. */
  read(length: number, address: number): Uint8Array;
}

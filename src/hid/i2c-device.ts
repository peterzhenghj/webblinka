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
  readonly address: number;
  /** Human-readable name, shown in demo mode. */
  readonly name: string;
  /** Master write. Registers, commands -- whatever the part understands. */
  write(data: Uint8Array): void;
  /** Master read of exactly `length` bytes. */
  read(length: number): Uint8Array;
}

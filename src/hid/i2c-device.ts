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

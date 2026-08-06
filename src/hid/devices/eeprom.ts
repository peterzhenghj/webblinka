import { NackError, type VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic 24-series serial EEPROM, parameterised the same three ways the
 * real family varies: capacity, page size, and one or two address bytes.
 *
 * It models the two behaviours that make these parts bite:
 *
 * **Page wrap.** Writing past the end of a page does not continue into the next
 * one. The internal address counter wraps to the start of the *same* page and
 * overwrites what was just stored, silently. Emulating that faithfully is the
 * whole reason this is worth having -- a virtual part that accepted a straight
 * 200-byte write would happily validate a driver that corrupts real hardware.
 *
 * **The write cycle.** After a write the part stops answering its address
 * entirely for a few milliseconds. Drivers are supposed to poll for the ACK,
 * and one that assumes the bus is always ready will appear to work here unless
 * the NACK is real.
 */

const ERASED = 0xff;

export interface EepromOptions {
  address?: number;
  /** Bytes of storage. */
  size?: number;
  pageSize?: number;
  addressBytes?: 1 | 2;
  /**
   * Address probes that NACK after a write, standing in for the write cycle.
   * Counted rather than timed so tests are deterministic and cannot hang.
   */
  busyProbes?: number;
  /** Initial contents. Short arrays are padded with erased bytes. */
  contents?: Uint8Array;
  /** Refuse writes, as the WP pin does. */
  writeProtected?: boolean;
}

export class VirtualEeprom implements VirtualI2cDevice {
  readonly address: number;
  readonly name: string;
  readonly size: number;
  readonly pageSize: number;
  readonly addressBytes: 1 | 2;
  writeProtected: boolean;

  readonly #memory: Uint8Array;
  readonly #busyProbes: number;
  /** Word address the internal counter is sitting at. */
  #pointer = 0;
  #busy = 0;
  /** Writes performed, for tests and for talking about endurance. */
  writeCycles = 0;

  constructor(options: EepromOptions = {}) {
    this.address = options.address ?? 0x50;
    this.size = options.size ?? 32 * 1024;
    this.pageSize = options.pageSize ?? 64;
    this.addressBytes = options.addressBytes ?? 2;
    this.#busyProbes = options.busyProbes ?? 2;
    this.writeProtected = options.writeProtected ?? false;
    this.name = `${this.size / 1024} KiB EEPROM`;

    this.#memory = new Uint8Array(this.size).fill(ERASED);
    if (options.contents) this.#memory.set(options.contents.subarray(0, this.size));
  }

  /** Read straight out of the array, bypassing the bus. For assertions. */
  peek(offset: number, length: number): Uint8Array {
    return this.#memory.slice(offset, offset + length);
  }

  write(data: Uint8Array): void {
    // A zero-length write is an address probe -- either a bus scan or a driver
    // polling for the end of a write cycle.
    if (data.length === 0) {
      if (this.#busy > 0) {
        this.#busy--;
        throw new NackError("write in progress");
      }
      return;
    }

    if (this.#busy > 0) {
      this.#busy--;
      throw new NackError("write in progress");
    }

    if (data.length < this.addressBytes) return; // a partial address does nothing
    this.#pointer =
      this.addressBytes === 1
        ? (data[0] ?? 0)
        : ((data[0] ?? 0) << 8) | (data[1] ?? 0);

    const payload = data.subarray(this.addressBytes);
    if (payload.length === 0) return; // address set, ready for a sequential read

    if (this.writeProtected) throw new NackError("write protected");

    const pageStart = Math.floor(this.#pointer / this.pageSize) * this.pageSize;
    for (let i = 0; i < payload.length; i++) {
      // The counter wraps within the page rather than carrying into the next.
      const at = pageStart + ((this.#pointer - pageStart + i) % this.pageSize);
      this.#memory[at % this.size] = payload[i] ?? ERASED;
    }
    this.writeCycles++;
    this.#busy = this.#busyProbes;
  }

  read(length: number): Uint8Array {
    if (this.#busy > 0) {
      this.#busy--;
      throw new NackError("write in progress");
    }
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      // Sequential reads roll over the whole array, not the page -- that
      // asymmetry with writes is real, and catches drivers that assume both.
      out[i] = this.#memory[(this.#pointer + i) % this.size] ?? ERASED;
    }
    this.#pointer = (this.#pointer + length) % this.size;
    return out;
  }
}

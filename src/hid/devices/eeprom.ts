import { NackError, type VirtualI2cDevice } from "../i2c-device.ts";

/**
 * A synthetic 24-series serial EEPROM, parameterised the same three ways the
 * real family varies: capacity, page size, and one or two address bytes.
 *
 * It models the three behaviours that make these parts bite:
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
 *
 * **Banking.** A part with more storage than its word address can reach borrows
 * the low bits of the *I2C* address for the high bits of the memory address, so
 * a 24C16 answers on all eight of 0x50-0x57 and leaves no A-pin free. Which
 * address a transfer arrives on is therefore part of the address, and the rule
 * -- ceil(size / span) consecutive addresses, span being 64 KiB for two-byte
 * word addresses and 256 bytes for one -- is Linux's at24 driver's.
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
  readonly addresses: readonly number[];
  readonly name: string;
  readonly size: number;
  readonly pageSize: number;
  readonly addressBytes: 1 | 2;
  /** Bytes reachable from one I2C address before banking takes over. */
  readonly span: number;
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

    this.span = this.addressBytes === 2 ? 65536 : 256;
    const banks = Math.max(1, Math.ceil(this.size / this.span));
    this.addresses = Array.from({ length: banks }, (_, i) => this.address + i);

    this.#memory = new Uint8Array(this.size).fill(ERASED);
    if (options.contents) this.#memory.set(options.contents.subarray(0, this.size));
  }

  /** Read straight out of the array, bypassing the bus. For assertions. */
  peek(offset: number, length: number): Uint8Array {
    return this.#memory.slice(offset, offset + length);
  }

  write(data: Uint8Array, address = this.address): void {
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
    const word =
      this.addressBytes === 1
        ? (data[0] ?? 0)
        : ((data[0] ?? 0) << 8) | (data[1] ?? 0);
    // Which address it arrived on supplies the bits above the word address.
    this.#pointer = (address - this.address) * this.span + word;

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

  read(length: number, address = this.address): Uint8Array {
    if (this.#busy > 0) {
      this.#busy--;
      throw new NackError("write in progress");
    }

    // The bank comes from the address the read arrived on, whatever the
    // pointer was left at -- those bits are part of the address, not state.
    const bank = address - this.address;
    const bankStart = bank * this.span;
    this.#pointer = bankStart + (this.#pointer % this.span);

    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      // Sequential reads roll over -- unlike writes, which wrap inside a page.
      // Modelled as wrapping within the bank, which is the conservative half of
      // a real split: some parts roll into the next slave address and some do
      // not (Linux flags those NO_RDROL). A driver that never lets a transfer
      // cross a bank works with both, and this catches one that does.
      out[i] = this.#memory[(bankStart + ((this.#pointer - bankStart + i) % this.span)) % this.size] ?? ERASED;
    }
    this.#pointer = bankStart + ((this.#pointer - bankStart + length) % this.span);
    return out;
  }
}

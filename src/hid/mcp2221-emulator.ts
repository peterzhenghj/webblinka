import type { VirtualI2cDevice } from "./i2c-device.ts";

/**
 * A software MCP2221 speaking the same 64-byte HID command protocol as the real
 * chip. It exists for two reasons: the Node test suite can exercise the entire
 * stack -- stock Blinka, the hid shim, JSPI, the RPC layer -- with no hardware
 * attached, and visitors without an adapter still get a working site.
 *
 * Command numbering and report layout follow the MCP2221 datasheet, but the
 * authority on what actually has to be right is Blinka's driver: every field
 * populated below is one that adafruit_blinka/microcontroller/mcp2221/mcp2221.py
 * reads. Fields it ignores are left zero rather than faked.
 */

// Commands.
const CMD_STATUS = 0x10;
const CMD_SET_GPIO = 0x50;
const CMD_GET_GPIO = 0x51;
const CMD_SET_SRAM = 0x60;
const CMD_GET_SRAM = 0x61;
const CMD_RESET = 0x70;
const CMD_I2C_READ_DATA = 0x40;
const CMD_I2C_WRITE = 0x90;
const CMD_I2C_READ = 0x91;
const CMD_I2C_WRITE_REPEATED = 0x92;
const CMD_I2C_READ_REPEATED = 0x93;
const CMD_I2C_WRITE_NOSTOP = 0x94;

// I2C engine states, as reported in status byte 8.
const STATE_IDLE = 0x00;
const STATE_ADDR_NACK = 0x25;
const STATE_WRITING_NO_STOP = 0x45;

// Status byte 20 flags, and Get-I2C-Data result codes.
const FLAG_ADDR_NACK = 0x40;
const READ_COMPLETE = 0x55;

const REPORT_SIZE = 64;
const MAX_I2C_CHUNK = 60;

/** GP pin designations, matching MCP2221.GP_* in Blinka. */
export const GP_GPIO = 0b000;
export const GP_ALT0 = 0b010; // ADC
export const GP_ALT1 = 0b011; // DAC

interface GpPin {
  mode: number;
  /** 1 = input, 0 = output, as Blinka's gpio_set_direction uses it. */
  direction: number;
  value: number;
}

interface PendingWrite {
  address: number;
  total: number;
  bytes: number[];
}

interface PendingRead {
  data: Uint8Array;
  offset: number;
  nacked: boolean;
}

export class Mcp2221Emulator {
  readonly #pins: GpPin[] = Array.from({ length: 4 }, () => ({
    mode: GP_GPIO,
    direction: 1,
    value: 0,
  }));
  readonly #bus = new Map<number, VirtualI2cDevice>();
  #adc: [number, number, number] = [0, 0, 0];
  #dac = 0;
  #clockDivider = 0x75; // ~100 kHz
  #i2cState = STATE_IDLE;
  #addrNacked = false;
  #write: PendingWrite | null = null;
  #read: PendingRead | null = null;

  attach(device: VirtualI2cDevice): void {
    this.#bus.set(device.address, device);
  }

  get devices(): VirtualI2cDevice[] {
    return [...this.#bus.values()];
  }

  /** Drive an ADC channel (0 = GP1, 1 = GP2, 2 = GP3) with a 10-bit value. */
  setAdc(channel: 0 | 1 | 2, value: number): void {
    this.#adc[channel] = Math.max(0, Math.min(0x3ff, Math.round(value)));
  }

  /** Last value written to the 5-bit DAC. */
  get dac(): number {
    return this.#dac;
  }

  pinState(pin: number): Readonly<GpPin> {
    const state = this.#pins[pin];
    if (!state) throw new RangeError(`no GP${pin}`);
    return state;
  }

  /** Handle one 64-byte command report. Returns the reply, or null for a reset. */
  handle(report: Uint8Array): Uint8Array | null {
    const command = report[0] ?? 0;
    if (command === CMD_RESET) {
      this.#resetState();
      return null;
    }

    const reply = new Uint8Array(REPORT_SIZE);
    reply[0] = command;
    reply[1] = 0x00;

    switch (command) {
      case CMD_STATUS:
        this.#status(report, reply);
        break;
      case CMD_SET_GPIO:
        this.#setGpio(report, reply);
        break;
      case CMD_GET_GPIO:
        this.#getGpio(reply);
        break;
      case CMD_SET_SRAM:
        this.#setSram(report);
        break;
      case CMD_GET_SRAM:
        this.#getSram(reply);
        break;
      case CMD_I2C_WRITE:
      case CMD_I2C_WRITE_REPEATED:
      case CMD_I2C_WRITE_NOSTOP:
        this.#i2cWrite(command, report, reply);
        break;
      case CMD_I2C_READ:
      case CMD_I2C_READ_REPEATED:
        this.#i2cRead(report, reply);
        break;
      case CMD_I2C_READ_DATA:
        this.#i2cGetData(reply);
        break;
      default:
        reply[1] = 0x01; // unsupported command
        break;
    }
    return reply;
  }

  // ------------------------------------------------------------- 0x10 status

  #status(report: Uint8Array, reply: Uint8Array): void {
    if (report[2] === 0x10) {
      const wasBusy = this.#i2cState !== STATE_IDLE || this.#write !== null || this.#read !== null;
      this.#i2cState = STATE_IDLE;
      this.#write = null;
      this.#read = null;
      // 0x10 means "marked for cancellation"; Blinka then waits for the bus.
      reply[2] = wasBusy ? 0x10 : 0x00;
    }
    if (report[3] === 0x20) {
      this.#clockDivider = report[4] ?? this.#clockDivider;
      reply[3] = 0x20; // divider accepted
    }

    reply[8] = this.#i2cState;
    const total = this.#write?.total ?? 0;
    const done = this.#write?.bytes.length ?? 0;
    reply[9] = total & 0xff;
    reply[10] = (total >> 8) & 0xff;
    reply[11] = done & 0xff;
    reply[12] = (done >> 8) & 0xff;
    reply[20] = this.#addrNacked ? FLAG_ADDR_NACK : 0x00;

    // ADC channels 0..2 sit at bytes 50/51, 52/53, 54/55 -- Blinka reads them as
    // resp[49 + 2*pin] << 8 | resp[48 + 2*pin] for GP1..GP3.
    for (let channel = 0; channel < 3; channel++) {
      const value = this.#adc[channel] ?? 0;
      reply[50 + 2 * channel] = value & 0xff;
      reply[51 + 2 * channel] = (value >> 8) & 0xff;
    }
  }

  // --------------------------------------------------------------- 0x50/0x51

  #setGpio(report: Uint8Array, reply: Uint8Array): void {
    for (let pin = 0; pin < 4; pin++) {
      const state = this.#pins[pin]!;
      // Each pin owns a four-byte block: [alter value, value, alter dir, dir].
      if (report[2 + 4 * pin] === 0x01) state.value = report[3 + 4 * pin] ?? 0;
      if (report[4 + 4 * pin] === 0x01) state.direction = report[5 + 4 * pin] ?? 1;
      const gpio = state.mode === GP_GPIO;
      reply[2 + 4 * pin] = gpio ? state.value : 0xee;
      reply[4 + 4 * pin] = gpio ? state.direction : 0xee;
    }
  }

  #getGpio(reply: Uint8Array): void {
    for (let pin = 0; pin < 4; pin++) {
      const state = this.#pins[pin]!;
      const gpio = state.mode === GP_GPIO;
      reply[2 + 2 * pin] = gpio ? state.value : 0xee;
      reply[3 + 2 * pin] = gpio ? state.direction : 0xee;
    }
  }

  // --------------------------------------------------------------- 0x60/0x61

  #setSram(report: Uint8Array): void {
    if ((report[4] ?? 0) & 0x80) this.#dac = (report[4] ?? 0) & 0b11111;
    if ((report[7] ?? 0) & 0x80) {
      for (let pin = 0; pin < 4; pin++) {
        this.#pins[pin]!.mode = (report[8 + pin] ?? 0) & 0x07;
      }
    }
    // Bytes 3 and 5 carry the DAC/ADC voltage references, which change nothing
    // observable here -- the emulated ADC is driven directly via setAdc().
  }

  #getSram(reply: Uint8Array): void {
    for (let pin = 0; pin < 4; pin++) {
      const state = this.#pins[pin]!;
      reply[22 + pin] = state.mode | (state.direction << 3) | (state.value << 4);
    }
  }

  // ------------------------------------------------------------------- I2C

  #i2cWrite(command: number, report: Uint8Array, reply: Uint8Array): void {
    const total = (report[1] ?? 0) | ((report[2] ?? 0) << 8);
    const address = (report[3] ?? 0) >> 1;

    if (!this.#bus.has(address)) {
      // Real hardware accepts the command and reports the NACK in the status
      // register afterwards; Blinka's i2c_scan depends on exactly that ordering.
      this.#addrNacked = true;
      this.#i2cState = STATE_ADDR_NACK;
      this.#write = null;
      return;
    }

    this.#addrNacked = false;
    if (!this.#write || this.#write.address !== address || this.#write.total !== total) {
      this.#write = { address, total, bytes: [] };
    }
    const remaining = total - this.#write.bytes.length;
    const size = Math.min(remaining, MAX_I2C_CHUNK);
    for (let i = 0; i < size; i++) this.#write.bytes.push(report[4 + i] ?? 0);

    if (this.#write.bytes.length < total) {
      this.#i2cState = STATE_WRITING_NO_STOP;
      reply[2] = this.#i2cState;
      return;
    }

    this.#bus.get(address)!.write(Uint8Array.from(this.#write.bytes));
    this.#write = null;
    // A no-stop write leaves the bus held so a repeated-start read can follow.
    this.#i2cState = command === CMD_I2C_WRITE_NOSTOP ? STATE_WRITING_NO_STOP : STATE_IDLE;
    reply[2] = this.#i2cState;
  }

  #i2cRead(report: Uint8Array, reply: Uint8Array): void {
    const total = (report[1] ?? 0) | ((report[2] ?? 0) << 8);
    const address = (report[3] ?? 0) >> 1;
    const device = this.#bus.get(address);

    if (!device) {
      this.#addrNacked = true;
      this.#i2cState = STATE_ADDR_NACK;
      this.#read = { data: new Uint8Array(0), offset: 0, nacked: true };
      return;
    }

    this.#addrNacked = false;
    const data = device.read(total);
    this.#read = { data, offset: 0, nacked: false };
    this.#i2cState = STATE_IDLE;
    reply[2] = this.#i2cState;
  }

  #i2cGetData(reply: Uint8Array): void {
    const pending = this.#read;
    if (!pending) {
      // Blinka reads "no data and no error" as a clean end of transfer.
      reply[2] = 0x00;
      reply[3] = 0x00;
      return;
    }
    if (pending.nacked) {
      reply[2] = STATE_ADDR_NACK;
      this.#read = null;
      return;
    }

    const chunk = pending.data.subarray(pending.offset, pending.offset + MAX_I2C_CHUNK);
    pending.offset += chunk.length;
    reply[2] = READ_COMPLETE;
    reply[3] = chunk.length;
    reply.set(chunk, 4);
    if (pending.offset >= pending.data.length) this.#read = null;
  }

  #resetState(): void {
    for (const pin of this.#pins) {
      pin.mode = GP_GPIO;
      pin.direction = 1;
      pin.value = 0;
    }
    this.#i2cState = STATE_IDLE;
    this.#addrNacked = false;
    this.#write = null;
    this.#read = null;
  }
}

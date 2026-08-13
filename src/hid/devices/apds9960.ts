import type { VirtualI2cDevice } from "../i2c-device.ts";

const REG_ENABLE = 0x80;
const REG_ATIME = 0x81;
const REG_WTIME = 0x83;
const REG_PERS = 0x8c;
const REG_CONFIG1 = 0x8d;
const REG_PPULSE = 0x8e;
const REG_CONTROL = 0x8f;
const REG_CONFIG2 = 0x90;
const REG_ID = 0x91;
const REG_STATUS = 0x92;
const REG_CDATAL = 0x93;
const REG_CDATAH = 0x94;
const REG_RDATAL = 0x95;
const REG_RDATAH = 0x96;
const REG_GDATAL = 0x97;
const REG_GDATAH = 0x98;
const REG_BDATAL = 0x99;
const REG_BDATAH = 0x9a;
const REG_PDATA = 0x9b;
const REG_GCONF4 = 0xab;
const REG_GFLVL = 0xae;
const REG_GSTATUS = 0xaf;

const ID_VALUE = 0xab;

export class VirtualApds9960 implements VirtualI2cDevice {
  readonly address = 0x39;
  readonly name = "APDS9960 proximity/gesture/color";
  readonly #regs = new Uint8Array(256);
  #pointer = 0;
  #t0 = Date.now();

  constructor() {
  
    this.#regs[REG_ATIME] = 0xff;
    this.#regs[REG_WTIME] = 0xff;
    this.#regs[REG_PERS] = 0x11;
    this.#regs[REG_CONFIG1] = 0x40;
    this.#regs[REG_PPULSE] = 0x89;
    this.#regs[REG_CONTROL] = 0x03;
    this.#regs[REG_CONFIG2] = 0x01;
    this.#regs[REG_ID] = ID_VALUE;
    this.#regs[REG_GCONF4] = 0x00;
  }

  write(data: Uint8Array): void {
    if (data.length === 0) return;

    this.#pointer = data[0];
   
    for (let i = 1; i < data.length; i++) {
      this.#regs[this.#pointer] = data[i];
      this.#pointer = (this.#pointer + 1) & 0xff;
    }
  }

  read(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = this.#readReg(this.#pointer);
      this.#pointer = (this.#pointer + 1) & 0xff;
    }
    return out;
  }

  #readReg(addr: number): number {

    if (addr === REG_PDATA) {
      const elapsed = (Date.now() - this.#t0) / 1000;
      return 128 + Math.round(Math.sin(elapsed * 0.5) * 60);
    }
  
    if (addr === REG_CDATAL) return 0x00;
    if (addr === REG_CDATAH) return 0x20;
    if (addr === REG_RDATAL) return 0x80;
    if (addr === REG_RDATAH) return 0x10;
    if (addr === REG_GDATAL) return 0x60;
    if (addr === REG_GDATAH) return 0x0c;
    if (addr === REG_BDATAL) return 0x40;
    if (addr === REG_BDATAH) return 0x08;
    
    if (addr === REG_GSTATUS) return 0x00;
    if (addr === REG_GFLVL) return 0x00;
    
    if (addr === REG_STATUS) {
      const enable = this.#regs[REG_ENABLE] ?? 0;
      let s = 0;
      if (enable & 0x04) s |= 0x20; // PVALID
      if (enable & 0x02) s |= 0x10; // AVALID
      return s;
    }
    return this.#regs[addr] ?? 0;
  }
}
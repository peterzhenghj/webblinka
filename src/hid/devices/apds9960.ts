import type { VirtualI2cDevice } from "../i2c-device.ts";

// APDS9960 寄存器地址（Command Byte 的 bit 5:0）
const REG_ENABLE = 0x00;
const REG_ATIME = 0x01;
const REG_WTIME = 0x03;
const REG_PERS = 0x0c;
const REG_CONFIG1 = 0x0d;
const REG_PPULSE = 0x0e;
const REG_CONTROL = 0x0f;
const REG_CONFIG2 = 0x10;
const REG_ID = 0x11;
const REG_STATUS = 0x12;
const REG_CDATAL = 0x13;
const REG_CDATAH = 0x14;
const REG_RDATAL = 0x15;
const REG_RDATAH = 0x16;
const REG_GDATAL = 0x17;
const REG_GDATAH = 0x18;
const REG_BDATAL = 0x19;
const REG_BDATAH = 0x1a;
const REG_PDATA = 0x1b;
const REG_GCONF4 = 0x2a;
const REG_GFLVL = 0x2e;
const REG_GSTATUS = 0x2f;

// 特殊命令（Bit 7 = 0）
const CMD_IFORCE = 0xe4;
const CMD_PICLEAR = 0xe5;
const CMD_CICLEAR = 0xe6;
const CMD_AICLEAR = 0xe7;

const ID_VALUE = 0xab;

export class VirtualApds9960 implements VirtualI2cDevice {
  readonly address = 0x39;
  readonly name = "APDS9960 proximity/gesture/color";
  readonly #regs = new Uint8Array(256);
  #pointer = 0;
  #t0 = Date.now();

  constructor() {
    // 上电默认值
    this.#regs[REG_ENABLE] = 0x00;
    this.#regs[REG_ATIME] = 0xff;
    this.#regs[REG_WTIME] = 0xff;
    this.#regs[REG_PERS] = 0x11;
    this.#regs[REG_CONFIG1] = 0x40;
    this.#regs[REG_PPULSE] = 0x89;
    this.#regs[REG_CONTROL] = 0x03;
    this.#regs[REG_CONFIG2] = 0x01;
    this.#regs[REG_ID] = ID_VALUE;
    this.#regs[REG_STATUS] = 0x00;
    this.#regs[REG_GCONF4] = 0x00;
  }

  write(data: Uint8Array): void {
    if (data.length === 0) return;

    const cmd = data[0]!;

    // APDS9960 Command Byte 格式：
    // Bit 7: 1 = 选择寄存器, 0 = 特殊命令
    // Bit 6: 0 = 不递增, 1 = 自动递增
    // Bit 5:0: 寄存器地址
    if ((cmd & 0x80) === 0) {
      // 特殊命令（Bit 7 = 0）
      if (cmd === CMD_IFORCE || cmd === CMD_PICLEAR || cmd === CMD_CICLEAR || cmd === CMD_AICLEAR) {
        return;
      }
      return;
    }

    const reg = cmd & 0x3f;
    const autoInc = (cmd & 0x40) !== 0;

    this.#pointer = reg;

    for (let i = 1; i < data.length; i++) {
      this.#regs[this.#pointer] = data[i]!;
      if (autoInc) {
        this.#pointer = (this.#pointer + 1) & 0xff;
      }
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
    // 动态数据：接近度缓慢变化
    if (addr === REG_PDATA) {
      const elapsed = (Date.now() - this.#t0) / 1000;
      return 128 + Math.round(Math.sin(elapsed * 0.5) * 60);
    }

    // 颜色数据：固定暖白色（16-bit，低字节在前）
    if (addr === REG_CDATAL) return 0x00;
    if (addr === REG_CDATAH) return 0x20;
    if (addr === REG_RDATAL) return 0x80;
    if (addr === REG_RDATAH) return 0x10;
    if (addr === REG_GDATAL) return 0x60;
    if (addr === REG_GDATAH) return 0x0c;
    if (addr === REG_BDATAL) return 0x40;
    if (addr === REG_BDATAH) return 0x08;

    // 手势 FIFO 为空
    if (addr === REG_GSTATUS) return 0x00;
    if (addr === REG_GFLVL) return 0x00;

    // 状态位：根据 ENABLE 寄存器返回有效标志
    if (addr === REG_STATUS) {
      const enable = this.#regs[REG_ENABLE] ?? 0;
      let s = 0;
      if (enable & 0x04) s |= 0x20; // PVALID (接近有效)
      if (enable & 0x02) s |= 0x10; // AVALID (颜色有效)
      if (enable & 0x40) s |= 0x04; // GVALID (手势有效)
      if (enable & 0x20) s |= 0x80; // CPSAT (颜色饱和)
      return s;
    }

    return this.#regs[addr] ?? 0;
  }
}
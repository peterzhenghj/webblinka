/**
 * A rolling record of the last few hundred HID transfers.
 *
 * When Blinka reports something like "Unrecoverable I2C state failure", the
 * traceback says which line raised but not *why* -- the interesting part is the
 * status byte the chip sent back, and that never reaches Python's traceback.
 * Dumping the transfers either side of a failure turns "the bus is unhappy" into
 * something readable, which matters most on hardware nobody debugging the code
 * necessarily has in front of them.
 */

const CAPACITY = 512;

/** MCP2221 command codes, for a legible trace. */
const COMMAND_NAMES: Record<number, string> = {
  0x10: "STATUS",
  0x40: "I2C_GET_DATA",
  0x50: "SET_GPIO",
  0x51: "GET_GPIO",
  0x60: "SET_SRAM",
  0x61: "GET_SRAM",
  0x70: "RESET",
  0x90: "I2C_WRITE",
  0x91: "I2C_READ",
  0x92: "I2C_WRITE_REPEAT",
  0x93: "I2C_READ_REPEAT",
  0x94: "I2C_WRITE_NOSTOP",
  0xb0: "READ_FLASH",
};

interface Entry {
  at: number;
  /** Report sent, without the hidapi report-ID byte. */
  out: Uint8Array;
  /** Reply received, or null if the read failed. */
  in: Uint8Array | null;
  error?: string;
}

export class HidTrace {
  #entries: Entry[] = [];
  #pendingOut: Uint8Array | null = null;

  /** Record an outgoing report. `data` still has its report-ID byte at index 0. */
  wrote(data: Uint8Array): void {
    this.#pendingOut = data.slice(1);
  }

  read(reply: Uint8Array): void {
    this.#push({ at: performance.now(), out: this.#pendingOut ?? new Uint8Array(), in: reply });
    this.#pendingOut = null;
  }

  failed(error: string): void {
    this.#push({
      at: performance.now(),
      out: this.#pendingOut ?? new Uint8Array(),
      in: null,
      error,
    });
    this.#pendingOut = null;
  }

  /**
   * The tail of the trace, formatted for a bug report. Only the leading bytes of
   * each report are shown: for every command in play the interesting fields --
   * echoed command, status, I2C engine state -- live in the first handful.
   */
  format(count = 24, bytes = 12): string {
    const tail = this.#entries.slice(-count);
    if (tail.length === 0) return "(no HID traffic recorded)";
    const start = tail[0]!.at;
    const lines = tail.map((entry) => {
      const at = `${(entry.at - start).toFixed(1).padStart(7)}ms`;
      const command = entry.out[0] ?? 0;
      const name = (COMMAND_NAMES[command] ?? `0x${command.toString(16)}`).padEnd(16);
      const out = hexBytes(entry.out, bytes);
      const reply = entry.error ? `!! ${entry.error}` : hexBytes(entry.in, bytes);
      return `${at}  ${name} → ${out}\n${" ".repeat(11)}${" ".repeat(16)}   ← ${reply}`;
    });
    return `last ${tail.length} HID transfers:\n${lines.join("\n")}`;
  }

  #push(entry: Entry): void {
    this.#entries.push(entry);
    if (this.#entries.length > CAPACITY) this.#entries.shift();
  }
}

function hexBytes(data: Uint8Array | null, limit: number): string {
  if (!data) return "(none)";
  const shown = [...data.subarray(0, limit)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  return data.length > limit ? `${shown} …` : shown;
}

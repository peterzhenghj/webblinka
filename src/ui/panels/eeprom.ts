import type { DevicePanel, DeviceSession } from "../../devices/panel.ts";
import { el, hex } from "../dom.ts";
import { panel, statusPill } from "../panel.ts";

export interface EepromInfo {
  address: number;
  label: string;
  size: number;
  pageSize: number;
  addressBytes: number;
  pages: number;
}

/** Bytes shown at once. One screenful, and one read, rather than the whole part. */
const WINDOW = 256;
const BYTES_PER_ROW = 16;

/**
 * A hex viewer and editor for serial EEPROMs.
 *
 * Reads a window at a time rather than the whole part. A 32 KiB AT24C256 is
 * about 550 I2C transactions to read end to end, which over HID is a few
 * seconds of stalled bus for data nobody has looked at yet.
 *
 * The page grid is drawn because page boundaries are where these parts bite. A
 * write that runs past the end of a page does not continue into the next one --
 * the address counter wraps to the start of the same page and quietly
 * overwrites what it just stored. The driver splits writes so this never
 * happens, but seeing the boundaries is how the behaviour stops being a
 * surprise the first time someone writes a struct across one.
 */
export class EepromPanel implements DevicePanel {
  readonly root: HTMLElement;
  readonly #session: DeviceSession;
  readonly #status = statusPill("Reading…", "busy");
  readonly #dump = el("div", { class: "hexdump" });
  readonly #legend = el("p", { class: "hint" });
  readonly #offsetInput: HTMLInputElement;
  readonly #writeOffset: HTMLInputElement;
  readonly #writeData: HTMLInputElement;
  readonly #message = el("p", { class: "hint" });
  #info: EepromInfo | null = null;
  #offset = 0;
  #window = new Uint8Array(0);
  #busy = false;

  constructor(session: DeviceSession) {
    this.#session = session;
    const p = panel("Contents");
    this.root = p.root;
    p.actions.append(this.#status.node);

    this.#offsetInput = el("input", { type: "text", value: "0x0000", class: "mono short" });
    const go = el("button", { text: "Go" });
    go.addEventListener("click", () => void this.#jump());
    this.#offsetInput.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") void this.#jump();
    });

    const prev = el("button", { text: "◀ Prev" });
    const next = el("button", { text: "Next ▶" });
    prev.addEventListener("click", () => void this.#step(-WINDOW));
    next.addEventListener("click", () => void this.#step(WINDOW));

    const refresh = el("button", { text: "Re-read" });
    refresh.addEventListener("click", () => void this.#load());

    const download = el("button", {
      text: "Download all",
      title: "Read the whole part and save it. Takes a moment on a large one.",
    });
    download.addEventListener("click", () => void this.#download(download));

    this.#writeOffset = el("input", { type: "text", value: "0x0000", class: "mono short" });
    this.#writeData = el("input", {
      type: "text",
      placeholder: "de ad be ef",
      class: "mono grow",
    });
    const write = el("button", { text: "Write" });
    write.addEventListener("click", () => void this.#write());

    const fillValue = el("input", { type: "text", value: "0xff", class: "mono short" });
    const fillLength = el("input", { type: "text", value: "256", class: "mono short" });
    const fill = el("button", { text: "Fill" });
    fill.addEventListener("click", () => void this.#fill(fillValue.value, fillLength.value));

    p.body.append(
      el("div", { class: "controls hexnav" }, [
        el("label", { class: "field" }, [el("span", { text: "Offset" }), this.#offsetInput]),
        go,
        prev,
        next,
        refresh,
        download,
      ]),
      this.#dump,
      this.#legend,
      el("fieldset", { class: "settings-group" }, [
        el("legend", { text: "Write" }),
        el("p", {
          class: "hint",
          text:
            "Hex bytes, split across page boundaries automatically. These parts " +
            "are good for about a million write cycles per page — fine to use, " +
            "not something to poll in a loop.",
        }),
        el("div", { class: "fields" }, [
          el("label", { class: "field" }, [el("span", { text: "At" }), this.#writeOffset]),
          el("label", { class: "field grow" }, [
            el("span", { text: "Bytes" }),
            this.#writeData,
          ]),
          write,
        ]),
        el("div", { class: "fields" }, [
          el("label", { class: "field" }, [el("span", { text: "Fill value" }), fillValue]),
          el("label", { class: "field" }, [el("span", { text: "Length" }), fillLength]),
          fill,
        ]),
      ]),
      this.#message,
    );
  }

  show(): void {
    if (this.#info === null) void this.#start();
  }

  hide(): void {
    // Nothing polls, so there is nothing to stop. An EEPROM only changes when
    // something writes to it, and that something is this panel.
  }

  async #start(): Promise<void> {
    try {
      this.#info = await this.#session.poll<EepromInfo>();
      await this.#load();
    } catch (err) {
      this.#fail(err);
    }
  }

  async #load(): Promise<void> {
    const info = this.#info;
    if (!info || this.#busy) return;
    this.#busy = true;
    this.#status.set("Reading…", "busy");
    try {
      const length = Math.min(WINDOW, info.size - this.#offset);
      const { data } = await this.#session.command<{ data: string }>(
        "read",
        this.#offset,
        length,
      );
      this.#window = decode(data);
      this.#render();
      this.#status.set(`${info.label} · ${(info.size / 1024).toFixed(0)} KiB`, "ok");
    } catch (err) {
      this.#fail(err);
    } finally {
      this.#busy = false;
    }
  }

  #render(): void {
    const info = this.#info;
    if (!info) return;

    const rows: HTMLElement[] = [];
    for (let row = 0; row < this.#window.length; row += BYTES_PER_ROW) {
      const at = this.#offset + row;
      const bytes = this.#window.subarray(row, row + BYTES_PER_ROW);
      const cells = [...bytes].map((byte, i) =>
        el("span", {
          class: byte === 0xff ? "hex-byte erased" : "hex-byte",
          text: byte.toString(16).padStart(2, "0"),
          title: `${hex(at + i, 4)} · ${byte} · ${printable(byte)}`,
        }),
      );
      const line = el("div", { class: "hex-row" }, [
        el("span", { class: "hex-offset", text: hex(at, 4) }),
        el("span", { class: "hex-bytes" }, cells),
        el("span", { class: "hex-ascii", text: [...bytes].map(printable).join("") }),
      ]);
      // Rule where a page starts, so the boundaries writes must respect are
      // visible rather than folklore.
      if (at % info.pageSize === 0) line.dataset.pageStart = "true";
      rows.push(line);
    }

    this.#dump.replaceChildren(...rows);
    const end = this.#offset + this.#window.length;
    this.#legend.textContent =
      `${hex(this.#offset, 4)}–${hex(end - 1, 4)} of ${hex(info.size - 1, 4)} · ` +
      `${info.pageSize}-byte pages (${info.pages} of them) · ` +
      `${info.addressBytes === 1 ? "8" : "16"}-bit word address · ` +
      `rules mark page starts · dimmed bytes are 0xff`;
  }

  async #jump(): Promise<void> {
    const parsed = parseNumber(this.#offsetInput.value);
    if (parsed === null || !this.#info) {
      this.#message.textContent = `Cannot read "${this.#offsetInput.value}" as an offset.`;
      return;
    }
    // Snap to a row so the dump lines up rather than starting mid-row.
    this.#offset = clamp(parsed - (parsed % BYTES_PER_ROW), 0, this.#info.size - 1);
    this.#offsetInput.value = hex(this.#offset, 4);
    await this.#load();
  }

  async #step(by: number): Promise<void> {
    if (!this.#info) return;
    this.#offset = clamp(this.#offset + by, 0, Math.max(0, this.#info.size - WINDOW));
    this.#offsetInput.value = hex(this.#offset, 4);
    await this.#load();
  }

  async #write(): Promise<void> {
    const offset = parseNumber(this.#writeOffset.value);
    const bytes = parseHexBytes(this.#writeData.value);
    if (offset === null) {
      this.#message.textContent = "Write offset is not a number.";
      return;
    }
    if (bytes === null || bytes.length === 0) {
      this.#message.textContent = "Give the bytes to write as hex, e.g. de ad be ef.";
      return;
    }
    await this.#apply(async () => {
      const result = await this.#session.command<{ written: number; pages: number }>(
        "write",
        offset,
        encode(bytes),
      );
      return (
        `Wrote ${result.written} bytes at ${hex(offset, 4)} across ` +
        `${result.pages} page write${result.pages === 1 ? "" : "s"}.`
      );
    });
  }

  async #fill(valueText: string, lengthText: string): Promise<void> {
    const offset = parseNumber(this.#writeOffset.value);
    const value = parseNumber(valueText);
    const length = parseNumber(lengthText);
    if (offset === null || value === null || length === null || length <= 0) {
      this.#message.textContent = "Fill needs an offset, a byte value and a length.";
      return;
    }
    await this.#apply(async () => {
      const result = await this.#session.command<{ written: number; pages: number }>(
        "fill",
        offset,
        length,
        value & 0xff,
      );
      return `Filled ${result.written} bytes at ${hex(offset, 4)} with ${hex(value & 0xff)}.`;
    });
  }

  async #apply(action: () => Promise<string>): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.#status.set("Writing…", "busy");
    try {
      this.#message.textContent = await action();
      this.#busy = false;
      await this.#load(); // show what actually landed, not what we sent
    } catch (err) {
      this.#busy = false;
      this.#fail(err);
    }
  }

  async #download(button: HTMLButtonElement): Promise<void> {
    const info = this.#info;
    if (!info || this.#busy) return;
    this.#busy = true;
    button.disabled = true;
    try {
      const all = new Uint8Array(new ArrayBuffer(info.size));
      // In window-sized bites so the serialised bus is released between them
      // and the progress is honest rather than one long freeze.
      for (let at = 0; at < info.size; at += WINDOW) {
        const length = Math.min(WINDOW, info.size - at);
        const { data } = await this.#session.command<{ data: string }>("read", at, length);
        all.set(decode(data), at);
        this.#status.set(`Reading… ${Math.round((at / info.size) * 100)}%`, "busy");
      }
      save(all, `${info.label.toLowerCase()}-${hex(info.address)}.bin`);
      this.#message.textContent = `Saved ${info.size} bytes.`;
      this.#status.set(`${info.label} · ${(info.size / 1024).toFixed(0)} KiB`, "ok");
    } catch (err) {
      this.#fail(err);
    } finally {
      this.#busy = false;
      button.disabled = false;
    }
  }

  #fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.#status.set("Failed", "error");
    this.#message.textContent = message;
  }
}

// ------------------------------------------------------------------ helpers

function printable(byte: number): string {
  return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "·";
}

function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = trimmed.startsWith("0x") || trimmed.startsWith("0X")
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number.parseInt(trimmed, 10);
  return Number.isFinite(value) ? value : null;
}

/** "de ad be ef", "deadbeef" and "de,ad" all mean the same four bytes. */
function parseHexBytes(text: string): Uint8Array | null {
  const cleaned = text.replace(/(0x)|[\s,]/gi, "");
  if (cleaned.length === 0 || cleaned.length % 2 !== 0 || /[^0-9a-f]/i.test(cleaned)) return null;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function save(bytes: Uint8Array<ArrayBuffer>, filename: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = el("a", { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}

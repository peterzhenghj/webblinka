import { el, hex } from "../dom.ts";
import { panel } from "../panel.ts";

export interface UsbDescriptors {
  manufacturer: string;
  product: string;
  serialNumber: string;
  factorySerialNumber: string;
  vendorId: number;
  productId: number;
  selfPowered: boolean;
  remoteWake: boolean;
  mARequested: number;
  chip: {
    cdcSerialEnumeration: boolean;
    uartRxLed: boolean;
    uartTxLed: boolean;
    i2cLed: boolean;
    sspnd: boolean;
    usbcfg: boolean;
    security: string;
  };
}

export interface DescriptorHandlers {
  read(): Promise<UsbDescriptors>;
}

/**
 * The identity the chip presents to USB, read out of its flash.
 *
 * Read-only by design. Rewriting these settings can change the VID/PID or lock
 * the chip behind a password, either of which would put it out of reach of this
 * page — WebHID's filter would stop matching it. Use Microchip's own utility for
 * that; it is not something a web page should offer.
 */
export class DescriptorsPanel {
  readonly root: HTMLElement;
  readonly #handlers: DescriptorHandlers;
  readonly #body: HTMLElement;
  #loaded = false;

  constructor(handlers: DescriptorHandlers) {
    this.#handlers = handlers;
    const p = panel("USB descriptors");
    this.root = p.root;
    this.#body = p.body;

    const refresh = el("button", { text: "Reload" });
    refresh.addEventListener("click", () => void this.load(true));
    p.actions.append(refresh);

    this.#body.append(el("p", { class: "hint", text: "Not connected." }));
  }

  /** Flash contents do not change under us, so read once unless asked again. */
  async load(force = false): Promise<void> {
    if (this.#loaded && !force) return;
    try {
      this.#render(await this.#handlers.read());
      this.#loaded = true;
    } catch (err) {
      this.#body.replaceChildren(
        el("div", {
          class: "notice",
          dataset: { tone: "error" },
          text: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  #render(usb: UsbDescriptors): void {
    this.#body.replaceChildren(
      el("dl", { class: "facts" }, [
        el("dt", { text: "Manufacturer" }),
        el("dd", { text: usb.manufacturer }),
        el("dt", { text: "Product" }),
        el("dd", { text: usb.product }),
        el("dt", { text: "Serial number" }),
        el("dd", { text: usb.serialNumber || "(none)" }),
        el("dt", { text: "Factory serial" }),
        el("dd", { text: usb.factorySerialNumber }),
        el("dt", { text: "Vendor ID" }),
        el("dd", { text: hex(usb.vendorId, 4) }),
        el("dt", { text: "Product ID" }),
        el("dd", { text: hex(usb.productId, 4) }),
        el("dt", { text: "Power" }),
        el("dd", {
          text:
            `${usb.selfPowered ? "self-powered" : "bus-powered"}, ` +
            `${usb.mARequested} mA requested` +
            `${usb.remoteWake ? ", remote wake" : ""}`,
        }),
        el("dt", { text: "Security" }),
        el("dd", { text: usb.chip.security }),
        el("dt", { text: "CDC enumeration" }),
        el("dd", { text: usb.chip.cdcSerialEnumeration ? "enabled" : "disabled" }),
        el("dt", { text: "Default LEDs" }),
        el("dd", { text: defaults(usb.chip) }),
      ]),
    );
  }
}

function defaults(chip: UsbDescriptors["chip"]): string {
  const on = [
    chip.uartRxLed && "UART Rx",
    chip.uartTxLed && "UART Tx",
    chip.i2cLed && "I²C",
    chip.sspnd && "SSPND",
    chip.usbcfg && "USBCFG",
  ].filter(Boolean);
  return on.length ? on.join(", ") : "none";
}

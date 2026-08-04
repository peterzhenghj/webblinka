import { DEVICES, defaultAddressOf, devicesAt, type DeviceEntry } from "../../devices/catalog.ts";
import type { DeviceManager } from "../../devices/manager.ts";
import { el, hex } from "../dom.ts";
import { panel } from "../panel.ts";

/**
 * Turns a bus scan into something you can open.
 *
 * Detection is a suggestion, never an action: an address only tells you
 * something answered there, and several parts share addresses. So the scan
 * proposes and the person decides — nothing talks to a device until asked,
 * which matters because starting a driver reconfigures the part.
 *
 * Everything in the catalogue is listed whether or not it was detected, since
 * a part can sit at a strapped address the catalogue does not know, and a
 * device that is not responding is exactly when you want to open its panel and
 * find out why.
 */
export class DevicesPanel {
  readonly root: HTMLElement;
  readonly #manager: DeviceManager;
  readonly #detected: HTMLElement;
  readonly #catalogue: HTMLElement;
  #found: number[] | null = null;

  constructor(manager: DeviceManager) {
    this.#manager = manager;
    const p = panel("Devices");
    this.root = p.root;

    this.#detected = el("div", { class: "device-list" });
    this.#catalogue = el("details", { class: "device-catalogue" }, [
      el("summary", { text: `All supported devices (${DEVICES.length})` }),
    ]);
    p.body.append(this.#detected, this.#catalogue);

    manager.onChange(() => this.render());
    this.render();
  }

  /** Called with each scan result; null means the bus has not been scanned. */
  setScan(found: number[] | null): void {
    this.#found = found;
    this.render();
  }

  render(): void {
    this.#renderDetected();
    this.#renderCatalogue();
  }

  #renderDetected(): void {
    if (this.#found === null) {
      this.#detected.replaceChildren(
        el("p", { class: "hint", text: "Scan the bus to see what is out there." }),
      );
      return;
    }

    const rows: HTMLElement[] = [];
    for (const address of this.#found) {
      const matches = devicesAt(address);
      if (matches.length === 0) {
        rows.push(
          el("div", { class: "device-row" }, [
            el("div", {}, [
              el("code", { text: hex(address) }),
              el("span", { class: "hint", text: " — no panel for this address yet" }),
            ]),
          ]),
        );
        continue;
      }
      // More than one match is normal: I2C addresses are not unique across
      // parts, so the catalogue proposes all of them rather than guessing.
      for (const device of matches) rows.push(this.#row(device, address, true));
    }

    this.#detected.replaceChildren(
      rows.length > 0
        ? el("div", {}, rows)
        : el("p", { class: "hint", text: "Nothing responded on the bus." }),
    );
  }

  #renderCatalogue(): void {
    const detected = new Set(this.#found ?? []);
    const rows = DEVICES.map((device) =>
      this.#row(device, defaultAddressOf(device), device.addresses.some((a) => detected.has(a))),
    );
    this.#catalogue.replaceChildren(
      el("summary", { text: `All supported devices (${DEVICES.length})` }),
      el("div", { class: "device-list" }, rows),
    );
  }

  #row(device: DeviceEntry, address: number, detected: boolean): HTMLElement {
    const open = this.#manager.isOpen(device, address);
    const button = el("button", {
      class: detected && !open ? "primary" : "",
      text: open ? "Open tab" : "Open",
    });
    button.addEventListener("click", () => {
      button.disabled = true;
      void this.#manager
        .open(device, address)
        .catch(() => undefined)
        .finally(() => {
          button.disabled = false;
        });
    });

    return el("div", { class: "device-row", dataset: { detected: String(detected) } }, [
      el("div", {}, [
        el("strong", { text: device.name }),
        el("span", { class: "hint", text: ` at ${hex(address)}` }),
        el("div", { class: "hint", text: device.description }),
      ]),
      button,
    ]);
  }
}

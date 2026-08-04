import type { PythonSession } from "../worker/client.ts";
import type { Tabs } from "../ui/tabs.ts";
import { el, hex } from "../ui/dom.ts";
import { defaultAddressOf, type DeviceEntry } from "./catalog.ts";
import type { DevicePanel } from "./panel.ts";

interface OpenDevice {
  handle: string;
  tabId: string;
  panel: DevicePanel;
}

/**
 * Opens and closes device panels.
 *
 * A device panel only exists once someone asks for it. Starting a driver talks
 * to the part -- the GPS gets reconfigured on start -- so nothing should happen
 * to hardware on the bus because a page loaded.
 */
export class DeviceManager {
  readonly #session: PythonSession;
  readonly #tabs: Tabs;
  readonly #open = new Map<string, OpenDevice>();
  readonly #listeners = new Set<() => void>();

  constructor(session: PythonSession, tabs: Tabs) {
    this.#session = session;
    this.#tabs = tabs;
  }

  /** Fires whenever a device opens or closes, so the scanner can restate itself. */
  onChange(fn: () => void): void {
    this.#listeners.add(fn);
  }

  isOpen(device: DeviceEntry, address: number): boolean {
    return this.#open.has(keyOf(device.id, address));
  }

  async open(device: DeviceEntry, address = defaultAddressOf(device)): Promise<void> {
    const key = keyOf(device.id, address);
    const existing = this.#open.get(key);
    if (existing) {
      this.#tabs.select(existing.tabId);
      return;
    }

    const { handle } = await this.#session.call<{ handle: string }>(
      "device_start",
      device.id,
      address,
    );

    const panel = device.create({
      address,
      poll: <T>() => this.#session.call<T>("device_poll", handle),
      command: <T>(name: string, ...args: unknown[]) =>
        this.#session.call<T>("device_command", handle, name, args),
    });

    const tabId = `device:${key}`;
    // Two of the same part on one bus need telling apart, so the address goes
    // in the label -- but only when it is genuinely ambiguous.
    const label =
      device.addresses.length > 1 ? `${device.name} ${hex(address)}` : device.name;

    this.#tabs.add(
      {
        id: tabId,
        label,
        content: el("div", {}, [this.#header(device, address, key), panel.root]),
        onShow: () => panel.show(),
        onHide: () => panel.hide(),
      },
      { select: true },
    );

    this.#open.set(key, { handle, tabId, panel });
    this.#notify();
  }

  async close(key: string): Promise<void> {
    const device = this.#open.get(key);
    if (!device) return;
    this.#open.delete(key);
    device.panel.hide();
    this.#tabs.remove(device.tabId);
    this.#notify();
    // Last, and tolerated if it fails: the panel is already gone from the UI,
    // and a driver that cannot be stopped should not look like a failed close.
    await this.#session.call("device_stop", device.handle).catch(() => undefined);
  }

  /** Close everything, e.g. after a chip reset invalidated the bus. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#open.keys()].map((key) => this.close(key)));
  }

  #header(device: DeviceEntry, address: number, key: string): HTMLElement {
    const close = el("button", { text: "Close" });
    close.addEventListener("click", () => void this.close(key));
    return el("div", { class: "device-header" }, [
      el("div", {}, [
        el("strong", { text: device.name }),
        el("span", { class: "hint", text: ` at ${hex(address)} · ${device.library}` }),
      ]),
      close,
    ]);
  }

  #notify(): void {
    for (const fn of this.#listeners) fn();
  }
}

export function keyOf(deviceId: string, address: number): string {
  return `${deviceId}@${hex(address)}`;
}

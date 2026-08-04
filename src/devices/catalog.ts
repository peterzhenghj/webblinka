import type { DevicePanel, DeviceSession } from "./panel.ts";
import { AhtPanel } from "../ui/panels/aht10.ts";
import { GpsPanel } from "../ui/panels/gps.ts";

/**
 * Every I2C device webblinka knows how to drive.
 *
 * Adding one is: write a Driver in python/webblinka/drivers/, write a panel,
 * and add an entry here. Nothing in the RPC layer, the tab shell or the scanner
 * needs to change -- they all work off this list.
 *
 * `addresses` is what connects a scan result to a panel. It is every address
 * the part can answer at, including strap-selectable ones, because suggesting
 * the right panel for an address the user chose with a solder blob is most of
 * the value of having a catalog at all.
 */
export interface DeviceEntry {
  /** Matches the id its Python driver registers under. */
  id: string;
  name: string;
  /** One line: what the thing is, not how it works. */
  description: string;
  /** Every I2C address the part can appear at. */
  addresses: number[];
  /** Used when opening without a scan match. Defaults to addresses[0]. */
  defaultAddress?: number;
  /** The CircuitPython library it drives, for the catalogue listing. */
  library: string;
  create(session: DeviceSession): DevicePanel;
}

export const DEVICES: DeviceEntry[] = [
  {
    id: "pa1010d",
    name: "PA1010D GPS",
    description: "Adafruit Mini GPS and other GTop I²C receivers",
    // The PA1010D is fixed at 0x10; GTop modules generally are.
    addresses: [0x10],
    library: "adafruit_circuitpython_gps",
    create: (session) => new GpsPanel(session),
  },
  {
    id: "aht10",
    name: "AHT10 / AHT20",
    description: "Temperature and humidity, with dew point derived",
    // The whole AHTx0 family is strapped to 0x38 with no address pins.
    addresses: [0x38],
    library: "adafruit_circuitpython_ahtx0",
    create: (session) => new AhtPanel(session),
  },
];

export function deviceById(id: string): DeviceEntry | undefined {
  return DEVICES.find((device) => device.id === id);
}

/** Catalogue entries that could account for an address the scan turned up. */
export function devicesAt(address: number): DeviceEntry[] {
  return DEVICES.filter((device) => device.addresses.includes(address));
}

export function defaultAddressOf(device: DeviceEntry): number {
  return device.defaultAddress ?? device.addresses[0] ?? 0;
}

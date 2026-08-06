import type { DevicePanel, DeviceSession } from "./panel.ts";
import { AhtPanel } from "../ui/panels/aht10.ts";
import { EepromPanel } from "../ui/panels/eeprom.ts";
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
  // The 24-series EEPROMs. One driver and one panel serve the whole family --
  // they differ only in capacity, page size and address width -- so a new part
  // is a row here and a row in EEPROM_TYPES. They all sit at 0x50-0x57 by their
  // A0/A1/A2 pins, which is why several of them offer the same eight addresses:
  // the scan cannot tell them apart, so it proposes all of them and you pick.
  ...eeproms(),
];

/**
 * Every catalogued EEPROM. Kept together because only the numbers differ, and
 * everything else about them follows from those numbers.
 *
 * The addresses are derived rather than listed. A part with more storage than
 * its word address can reach borrows the low bits of the I2C address for the
 * high bits of the memory address, so it occupies several consecutive
 * addresses -- ceil(size / span), where span is 64 KiB for a two-byte word
 * address and 256 bytes for a one-byte one, which is Linux's at24 rule. Those
 * are addresses the A-pins can no longer reach: a 24C04 eats two and can only
 * start on an even one, and a 24C16 eats all eight and cannot be moved at all.
 */
function eeproms(): DeviceEntry[] {
  const parts: [id: string, name: string, bytes: number, page: number, addrBytes: 1 | 2][] = [
    ["at24c512", "AT24C512", 64 * 1024, 128, 2],
    ["at24c256", "AT24C256", 32 * 1024, 64, 2],
    ["at24c128", "AT24C128", 16 * 1024, 64, 2],
    ["at24c64", "AT24C64", 8 * 1024, 32, 2],
    ["24lc32", "24LC32", 4 * 1024, 32, 2],
    ["at24c16", "AT24C16", 2 * 1024, 16, 1],
    ["at24c08", "AT24C08", 1024, 16, 1],
    ["at24c04", "AT24C04", 512, 16, 1],
    ["at24c02", "AT24C02", 256, 8, 1],
    ["at24c01", "AT24C01", 128, 8, 1],
  ];
  return parts.map(([id, name, bytes, page, addrBytes]) => {
    const span = addrBytes === 2 ? 65536 : 256;
    const banks = Math.max(1, Math.ceil(bytes / span));
    const addresses: number[] = [];
    for (let base = 0x50; base + banks - 1 <= 0x57; base += banks) addresses.push(base);
    return {
      id,
      name: `${name} EEPROM`,
      description:
        `${bytes >= 1024 ? `${bytes / 1024} KiB` : `${bytes} B`}, ${page}-byte pages` +
        (banks > 1 ? `, spans ${banks} addresses` : ""),
      addresses,
      library: "adafruit_bus_device",
      create: (session) => new EepromPanel(session),
    };
  });
}

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

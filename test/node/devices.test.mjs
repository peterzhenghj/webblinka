// The device registry is what makes "support a lot of I2C devices" a matter of
// adding a driver and a panel rather than touching the RPC layer. These cover
// the generic contract, plus the one invariant that spans the two languages:
// every entry in the TypeScript catalogue must have a Python driver behind it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEVICES, defaultAddressOf, devicesAt } from "../../src/devices/catalog.ts";
import { VirtualPa1010d } from "../../src/hid/devices/pa1010d.ts";
import { bootStack, demoChip } from "./fixtures/stack.mjs";

test("every catalogued device has a driver registered under its id", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  const registered = await call("device_ids");

  for (const device of DEVICES) {
    assert.ok(
      registered.includes(device.id),
      `${device.name} is in the catalogue but no Python driver registers "${device.id}"`,
    );
  }
});

test("catalogue entries are well formed", () => {
  const seen = new Set();
  for (const device of DEVICES) {
    assert.ok(!seen.has(device.id), `duplicate device id ${device.id}`);
    seen.add(device.id);
    assert.ok(device.addresses.length > 0, `${device.id} declares no addresses`);
    for (const address of device.addresses) {
      // Outside 0x08-0x77 the scan never probes, so a panel there is unreachable.
      assert.ok(address >= 0x08 && address <= 0x77, `${device.id}: ${address} is reserved`);
    }
    assert.ok(
      device.addresses.includes(defaultAddressOf(device)),
      `${device.id}: default address is not one of its addresses`,
    );
  }
});

test("an address maps to the devices that can account for it", () => {
  assert.deepEqual(
    devicesAt(0x10).map((d) => d.id),
    ["pa1010d"],
  );
  assert.deepEqual(devicesAt(0x42), [], "an unclaimed address suggests nothing");
});

test("a device is only running once it is started", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");

  // Nothing may touch hardware because a page loaded: starting the GPS driver
  // reconfigures the module's sentence output.
  assert.deepEqual(await call("device_active"), []);

  const { handle } = await call("device_start", "pa1010d", 0x10);
  assert.deepEqual(await call("device_active"), [handle]);

  await call("device_stop", handle);
  assert.deepEqual(await call("device_active"), []);
  await assert.rejects(() => call("device_poll", handle), /not running/);
});

test("the same part at two addresses is two instances", async () => {
  const chip = demoChip();
  // A second GTop module strapped elsewhere on the same bus.
  chip.attach(new VirtualPa1010d({ address: 0x42 }));
  const { call } = await bootStack({ chip });
  await call("connect");

  const first = await call("device_start", "pa1010d", 0x10);
  const second = await call("device_start", "pa1010d", 0x42);

  assert.notEqual(first.handle, second.handle);
  assert.deepEqual(await call("device_active"), ["pa1010d@0x10", "pa1010d@0x42"]);

  await call("device_stop", second.handle);
  assert.deepEqual(await call("device_active"), ["pa1010d@0x10"]);
});

test("restarting a device replaces the old instance", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");

  await call("device_start", "pa1010d", 0x10);
  await call("device_start", "pa1010d", 0x10);
  assert.deepEqual(await call("device_active"), ["pa1010d@0x10"], "no duplicate instance");
});

test("commands reach the driver", async () => {
  const chip = demoChip();
  const gps = chip.devices[0];
  const { call } = await bootStack({ chip });
  await call("connect");

  const { handle } = await call("device_start", "pa1010d", 0x10);
  gps.commands.length = 0;
  await call("device_command", handle, "set_rate", [2000]);
  assert.ok(
    gps.commands.some((c) => c.startsWith("$PMTK220,2000")),
    `expected a rate command, got ${JSON.stringify(gps.commands)}`,
  );
});

test("starting a device that is not there fails cleanly", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");
  // The CircuitPython libraries probe on construction, so a wrong address is
  // caught immediately rather than becoming a panel that never updates.
  await assert.rejects(() => call("device_start", "pa1010d", 0x42), /NACK/);
  assert.deepEqual(await call("device_active"), []);
});

test("an unknown device id says what is available", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");
  await assert.rejects(() => call("device_start", "bme280", 0x77), /no driver 'bme280'/);
});

test("a chip reset stops every running driver", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "pa1010d", 0x10);

  await call("reset_chip");
  await call("rebuild_bus");

  // Their configuration did not survive the reset, so neither should they.
  assert.deepEqual(await call("device_active"), []);
});

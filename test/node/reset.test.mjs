// Some I2C engine states no cancel can reach -- a transfer abandoned mid-flight
// leaves the chip trying to issue a STOP forever. Blinka clears that by
// resetting the chip on every startup, which webblinka cannot do blindly: the
// device drops off USB and re-enumerates, invalidating the HIDDevice the page
// holds. So it is an explicit recovery, and this covers that it works.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, demoChip } from "./fixtures/stack.mjs";

test("a wedged engine survives every cancel, and a reset clears it", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  chip.wedge(); // stuck issuing a STOP

  const stuck = await call("force_idle");
  assert.equal(stuck.idle, false);
  assert.equal(stuck.state, "stop", "cancelling cannot reach this state");

  await call("reset_chip");
  const after = await call("rebuild_bus");
  assert.equal(after.idle, true, "a reset is the only way out");
  assert.equal(after.state, "idle");
});

test("bus line levels separate a stuck chip from a held bus", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  // Chip's fault: the bus is free, both lines released.
  chip.wedge(0x60, false);
  let bus = await call("force_idle");
  assert.deepEqual([bus.scl, bus.sda], [1, 1], "a free bus means resetting will help");

  // Someone else's fault: a device is holding the lines down, and no amount of
  // resetting the MCP2221 releases a line another chip is pulling.
  chip.wedge(0x60, true);
  bus = await call("force_idle");
  assert.deepEqual([bus.scl, bus.sda], [0, 0]);
});

test("resync repairs Blinka's cached pin config after a reset", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  await call("gpio_configure", "G2", "analog_out");
  assert.equal(chip.pinState(2).mode, 0b011, "DAC designation");

  await call("reset_chip");
  await call("rebuild_bus");
  assert.equal(chip.pinState(2).mode, 0b000, "reset returns pins to flash defaults");

  // Blinka caches all four GP bytes so it can change one without disturbing the
  // others. If resync did not refresh that cache, configuring G0 here would
  // write back the pre-reset designation for G2 along with it.
  await call("gpio_configure", "G0", "output");
  assert.equal(chip.pinState(2).mode, 0b000, "G2 must not be resurrected from a stale cache");
});

test("the bus works again after a reset", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  chip.wedge();
  await call("reset_chip");
  await call("rebuild_bus");

  assert.deepEqual(await call("i2c_scan"), [0x10], "the GPS is still reachable");
});

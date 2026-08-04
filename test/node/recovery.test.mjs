// A cancel is a request the MCP2221 takes "a few hundred microseconds" to
// honour. Blinka waits a flat 1ms and then issues its next command; when the
// engine is still winding down it rejects that command as busy and echoes the
// state it is still in, which Blinka reads as a fatal bus condition and turns
// into "Unrecoverable I2C state failure" -- aborting the whole scan over one
// sulky address.
//
// cancelLatency on the emulator reproduces that window deterministically.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, demoChip } from "./fixtures/stack.mjs";

test("a slow cancel does not abort the scan", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  // Slow enough that Blinka's own single-shot cancel inside _i2c_write never
  // wins the race, so every probe after a NACK hits the busy rejection.
  chip.cancelLatency = 2;

  const found = await call("i2c_scan");
  assert.deepEqual(found, [0x10], "the GPS must still be found past the wedged probes");
});

test("force_idle polls until the engine is genuinely idle", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  chip.cancelLatency = 4;
  // Leave the engine mid-NACK, the state a scan keeps landing in.
  await assert.rejects(() => call("gps_start", 0x77));

  const bus = await call("force_idle");
  assert.equal(bus.idle, true);
  assert.equal(bus.state, "idle");
  assert.equal((await call("chip_status")).i2c.stateName, "idle");
});

test("connect reports the state the engine settled into", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  const board = await call("connect");
  assert.equal(board.bus.state, "idle");
  assert.equal(board.bus.idle, true);
  assert.deepEqual([board.bus.scl, board.bus.sda], [1, 1]);
});

test("the scan probes only unreserved addresses, and writes nothing", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  const probed = [];
  chip.onProbe = (address, length) => probed.push({ address, length });
  await call("i2c_scan");

  assert.equal(probed.at(0)?.address, 0x08, "0x00-0x07 are reserved");
  assert.equal(probed.at(-1)?.address, 0x77, "0x78-0x7f are reserved");
  // A zero-length write is the standard probe; Blinka's own scan writes a 0x00
  // byte instead, which on address 0x00 is the general-call software reset.
  assert.ok(
    probed.every((p) => p.length === 0),
    "a scan must not write data into whatever is on the bus",
  );
});

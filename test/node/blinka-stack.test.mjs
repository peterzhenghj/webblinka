// End-to-end: unmodified Adafruit Blinka, running in Pyodide, driving the
// emulated MCP2221 through python/hid.py.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, demoChip } from "./fixtures/stack.mjs";

test("Blinka boots against the emulated MCP2221", async () => {
  const { call } = await bootStack({ chip: demoChip() });

  const board = await call("connect");
  assert.equal(board.chip, "MCP2221");
  assert.equal(board.board, "MICROCHIP_MCP2221");
  assert.deepEqual(board.pins, ["G0", "G1", "G2", "G3"]);

  const runtime = await call("runtime_info");
  assert.equal(runtime.connected, true);
  assert.match(runtime.blinka, /^\d+\.\d+\.\d+$/);
});

test("i2c_scan finds exactly the attached devices", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  const found = await call("i2c_scan");
  assert.deepEqual(
    found,
    chip.devices.map((d) => d.address),
    "scan should report the GPS at 0x10 and nothing else",
  );
});

test("a NACK on one address does not poison the next", async () => {
  // i2c_scan walks every address, so a stale NACK flag would make every probe
  // after the first failure look like a NACK too. Scanning twice and getting
  // the same answer is the cheap way to catch that.
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  const first = await call("i2c_scan");
  const second = await call("i2c_scan");
  assert.deepEqual(first, second);
  assert.deepEqual(first, [0x10]);
});

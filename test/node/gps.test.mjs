// The whole point of the project, end to end: the stock adafruit_gps library,
// unmodified, parsing NMEA that arrived byte-by-byte over an emulated I2C bus.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, demoChip } from "./fixtures/stack.mjs";

test("adafruit_gps reaches a fix over the emulated bus", async () => {
  // acquireMs:0 skips the simulated cold start so the test does not wait 6s.
  const chip = demoChip({ acquireMs: 0 });
  const { call } = await bootStack({ chip });
  await call("connect");

  assert.deepEqual(await call("gps_start"), { address: 0x10 });

  let state = null;
  for (let attempt = 0; attempt < 6 && !state?.hasFix; attempt++) {
    state = await call("gps_poll");
  }

  assert.ok(state.hasFix, `never got a fix: ${JSON.stringify(state)}`);
  assert.equal(state.fixQuality, 1);
  assert.ok(state.satellites >= 4, `expected satellites, got ${state.satellites}`);
  assert.ok(Math.abs(state.latitude - 37.7749) < 0.001, `latitude ${state.latitude}`);
  assert.ok(Math.abs(state.longitude + 122.4194) < 0.001, `longitude ${state.longitude}`);
  assert.match(state.timestampUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(
    state.sentences.some((s) => s.startsWith("$GPGGA")),
    "should have kept raw sentences",
  );
});

test("the driver configures the module on start", async () => {
  const chip = demoChip({ acquireMs: 0 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("gps_start");

  const [gps] = chip.devices;
  assert.ok(
    gps.commands.some((c) => c.startsWith("$PMTK314")),
    `expected a sentence-select command, got ${JSON.stringify(gps.commands)}`,
  );
  assert.ok(gps.commands.some((c) => c.startsWith("$PMTK220")));
});

test("polling before start is a clear error", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");
  await assert.rejects(() => call("gps_poll"), /GPS not started/);
});

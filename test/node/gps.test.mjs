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

test("the sky view reports per-satellite signal and which are in the fix", async () => {
  const chip = demoChip({ acquireMs: 0 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("gps_start");

  // GSV goes out every fifth fix, so the sky view takes a few polls to arrive.
  let state = null;
  for (let attempt = 0; attempt < 12 && !state?.sky?.length; attempt++) {
    state = await call("gps_poll");
  }

  assert.ok(state.sky.length > 0, `no satellites reported: ${JSON.stringify(state.sky)}`);
  for (const sat of state.sky) {
    assert.match(sat.prn, /^GP\d+$/);
    assert.ok(sat.snr === null || (sat.snr >= 0 && sat.snr <= 99), `snr ${sat.snr}`);
    assert.ok(sat.elevation === null || (sat.elevation >= 0 && sat.elevation <= 90));
    assert.ok(sat.azimuth === null || (sat.azimuth >= 0 && sat.azimuth < 360));
  }

  // Strongest first, so the bars read left to right without the panel sorting.
  const snrs = state.sky.map((s) => s.snr ?? 0);
  assert.deepEqual(snrs, [...snrs].sort((a, b) => b - a), "sky view should be strongest first");

  // GSA says which of the satellites in view the solution actually used; that
  // gap is the whole diagnostic, so it must survive into the payload.
  assert.ok(
    state.sky.some((s) => s.used),
    "with a fix, some satellites should be marked as used",
  );
});

test("progress is reported before there is any fix to report", async () => {
  // A long cold start, so the module is still acquiring while we look.
  const chip = demoChip({ acquireMs: 60_000 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("gps_start");

  const state = await call("gps_poll");
  assert.equal(state.hasFix, false);
  // Without these, a GPS that is patiently acquiring is indistinguishable from
  // one that is broken -- which is the entire reason the panel shows them.
  assert.ok(state.elapsedS >= 0, "elapsed time should be counting");
  assert.equal(state.timeToFirstFixS, null);
  assert.ok(state.sentenceCount > 0, "sentences should be arriving even without a fix");
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

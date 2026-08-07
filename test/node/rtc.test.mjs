// The RV-1805, and the thing an RTC panel is actually for: measuring drift.
// A clock read once tells you nothing about its quality, so the interesting
// assertions here are about the rate and about how honestly it is qualified.

import { test } from "node:test";
import assert from "node:assert/strict";

import { VirtualWrongPart, VirtualSilentPart } from "../../src/hid/devices/rv1805.ts";
import { Mcp2221Emulator } from "../../src/hid/mcp2221-emulator.ts";
import { bootStack, chipWithRtc } from "./fixtures/stack.mjs";

const flagsOf = (state) => Object.fromEntries(state.flags.map((f) => [f.label, f]));

/**
 * A stopped clock, for the tests that are about decoding rather than elapsing.
 *
 * The emulated part keeps real time by default, so anything asserting on what
 * it reads back is racing Pyodide's boot -- a second or two locally and five on
 * a loaded CI runner. Freezing `now` makes the device read back exactly what it
 * was given, which is both what these tests mean and what they can assert.
 */
function frozen(options = {}) {
  const at = options.epoch === undefined ? Date.now() : options.epoch * 1000;
  return chipWithRtc({ ...options, now: () => at });
}

/** A clock the test drives by hand, so drift is exact rather than wall-clock. */
function clocked(options = {}) {
  const state = { ms: Date.UTC(2026, 0, 2, 3, 4, 5) };
  const rig = chipWithRtc({ ...options, now: () => state.ms, epoch: state.ms / 1000 });
  return { ...rig, state };
}

test("reads the calendar back as UTC", async () => {
  const { chip } = frozen({ epoch: Date.UTC(2026, 6, 4, 12, 34, 56) / 1000 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  const state = await call("device_poll", "rv1805@0x69");
  // To the second, because the clock is stopped. Matching only the first nine
  // of the minute's ten seconds meant the assertion failed whenever Pyodide
  // took more than four seconds to boot, which on CI it does.
  assert.match(state.iso, /^2026-07-04T12:34:56/, `got ${state.iso}`);
  assert.equal(state.label, "RV-1805");
});

test("checks the part number rather than trusting the address", async () => {
  // 0x69 is shared -- an MPU-6050 lives there too -- so something answering is
  // not evidence that it is the clock.
  const chip = new Mcp2221Emulator();
  chip.attach(new VirtualWrongPart(0x69));
  const { call } = await bootStack({ chip });
  await call("connect");

  // At open, not on the first reading. The wrong part's registers still decode
  // -- into a month of 68 and an exception about the calendar, which says
  // nothing about what is actually wrong.
  await assert.rejects(
    () => call("device_start", "rv1805", 0x69),
    /part number/,
    "should name what it found",
  );
});

test("a part that will not answer fails at start", async () => {
  const chip = new Mcp2221Emulator();
  chip.attach(new VirtualSilentPart(0x69));
  const { call } = await bootStack({ chip });
  await call("connect");
  await assert.rejects(() => call("device_start", "rv1805", 0x69));
});

test("setting the clock from a host timestamp round-trips", async () => {
  const { chip } = frozen({ epoch: 0 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  const target = Date.UTC(2027, 10, 23, 1, 2, 3) / 1000;
  const after = await call("device_command", "rv1805@0x69", "set_from_unix", [target]);
  assert.match(after.iso, /^2027-11-23T01:02:03/, `got ${after.iso}`);

  // And the offset against the host is now the difference between the host's
  // real clock and the fictional date it was just set to, not a small number.
  const state = await call("device_poll", "rv1805@0x69");
  assert.ok(Math.abs(state.deviceUnix - target) < 2, "device holds what it was given");
});

test("measures a known drift rate", async () => {
  // 500 ppm fast, an absurd clock, chosen so the answer is unambiguous.
  const { chip, state } = clocked({ driftPpm: 500 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  await call("device_poll", "rv1805@0x69"); // baseline
  state.ms += 3600_000; // an hour of simulated time
  const drifted = await call("device_poll", "rv1805@0x69");

  // The host clock is real and the device clock is simulated, so the elapsed
  // time the driver sees is the real one -- the ratio is what matters, and the
  // sign and rough magnitude are the assertions worth making here.
  assert.ok(drifted.driftPpm > 0, `expected fast, got ${drifted.driftPpm}`);
  assert.ok(drifted.elapsedS > 0);
});

test("says a drift measurement is too short to mean anything", async () => {
  const { chip } = chipWithRtc({ driftPpm: 0 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  const first = await call("device_poll", "rv1805@0x69");
  const second = await call("device_poll", "rv1805@0x69");

  // Over a fraction of a second, one hundredth-of-a-second tick is an enormous
  // rate. The panel uses this to refuse to quote a figure yet.
  assert.equal(first.driftPpm, null, "no rate at all from a single reading");
  assert.ok(second.resolutionPpm > 1000, `got ${second.resolutionPpm} ppm resolution`);
  assert.equal(second.resolutionS, 0.01, "this part counts hundredths");
});

test("reports the read latency as the floor on the offset", async () => {
  // Every reading is dozens of HID round-trips, so the device's time
  // corresponds to somewhere inside that window and the panel must not quote
  // an offset tighter than the window is wide.
  const { chip } = chipWithRtc();
  const { call } = await bootStack({ chip, transferDelayMs: 1 });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  const state = await call("device_poll", "rv1805@0x69");
  assert.ok(state.uncertaintyS > 0, "a read takes time and the panel says so");
  assert.ok(state.uncertaintyS < 5, `implausible: ${state.uncertaintyS}s`);
});

test("the oscillator-failure latch can be cleared", async () => {
  // Sticky, and set from the factory: it latches whenever the crystal has not
  // been running, so a part that has never had a backup cell reports it
  // forever until something clears it. It is a claim about the past.
  const { chip, rtc } = chipWithRtc({ oscillatorFault: true });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  const before = flagsOf(await call("device_poll", "rv1805@0x69"));
  assert.match(before["Oscillator stopped"].value, /^yes/);
  assert.equal(before["Oscillator stopped"].action, "clear_fault", "offers the fix inline");

  await call("device_command", "rv1805@0x69", "clear_fault", []);
  assert.equal(rtc.oscillatorFault, false, "the bit is actually cleared on the part");
  assert.equal(flagsOf(await call("device_poll", "rv1805@0x69"))["Oscillator stopped"].value, "no");
});

test("setting the clock clears the failure latch too", async () => {
  // Writing the time is what makes the data valid again, which is exactly when
  // the flag stops being true -- Linux's abx80x driver clears it there as well.
  const { chip, rtc } = chipWithRtc({ oscillatorFault: true });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  await call("device_command", "rv1805@0x69", "set_from_unix", [Date.now() / 1000]);
  assert.equal(rtc.oscillatorFault, false);
});

test("the failure flag is not reported while running on the RC", async () => {
  // There is no crystal to have failed, so the bit means nothing. Linux does
  // not even read it in this mode.
  const { chip } = chipWithRtc({ oscillatorFault: true, onRcOscillator: true });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  const flags = flagsOf(await call("device_poll", "rv1805@0x69"));
  assert.equal(flags["Oscillator stopped"], undefined, "not a row at all on the RC");
  assert.match(flags.Oscillator.value, /RC/);
});

test("surfaces the status bits that explain a bad clock", async () => {
  const { chip } = chipWithRtc({ onRcOscillator: true, onBackupPower: true, stopped: true });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  const flags = flagsOf(await call("device_poll", "rv1805@0x69"));
  // Running on the RC costs orders of magnitude of accuracy and looks
  // identical in the time registers, so it has to be visible somewhere.
  assert.match(flags.Oscillator.value, /RC/);
  assert.equal(flags.Oscillator.tone, "warn");
  assert.match(flags.Power.value, /backup/);
  assert.match(flags.Counting.value, /stopped/);
  assert.equal(flags.Counting.tone, "error");
});

test("a healthy part reports healthy", async () => {
  const { chip } = chipWithRtc();
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  const flags = (await call("device_poll", "rv1805@0x69")).flags;
  assert.ok(flags.every((f) => f.tone === "ok"), JSON.stringify(flags));
  assert.match(flags.find((f) => f.label === "Oscillator").value, /XT/);
});

test("restarting the drift baseline forgets the old one", async () => {
  const { chip, state } = clocked({ driftPpm: 1000 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  await call("device_poll", "rv1805@0x69");
  state.ms += 600_000;
  await call("device_poll", "rv1805@0x69");

  const restarted = await call("device_command", "rv1805@0x69", "reset_drift", []);
  assert.equal(restarted.driftPpm, null, "back to having no baseline");
  assert.equal(restarted.elapsedS, 0);
});

test("setting the clock keeps the fraction of a second", async () => {
  // Truncating to whole seconds would leave every clock this panel sets slow
  // by up to a second -- five centuries of error budget on a part specified to
  // two parts per million.
  // Frozen, so the twenty-millisecond bound below measures the part's own
  // resolution rather than however long the round trip happened to take.
  const { chip, rtc } = frozen({ epoch: 0 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  const target = Date.UTC(2026, 3, 5, 6, 7, 8) / 1000 + 0.75;
  await call("device_command", "rv1805@0x69", "set_from_unix", [target]);

  // One hundredth is the part's own resolution, so that is the bound to hold.
  assert.ok(
    Math.abs(rtc.deviceUnix - target) < 0.02,
    `off by ${((rtc.deviceUnix - target) * 1000).toFixed(0)} ms`,
  );
});

test("a fraction that rounds up carries into the next second", async () => {
  const { chip, rtc } = frozen({ epoch: 0 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "rv1805", 0x69);

  // 59.999 must become the next minute, not a sixtieth second.
  const target = Date.UTC(2026, 3, 5, 6, 7, 59) / 1000 + 0.999;
  const after = await call("device_command", "rv1805@0x69", "set_from_unix", [target]);

  assert.match(after.iso, /T06:08:00/, `got ${after.iso}`);
  assert.ok(Math.abs(rtc.deviceUnix - target) < 0.02);
});

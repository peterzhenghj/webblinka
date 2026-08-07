// The TSL2591 driver, end to end: stock adafruit_tsl2591 against the emulated
// part, through Blinka and the hid shim.
//
// The tests that matter here are about range rather than about lux. Any stub
// can return a number; what this part gets wrong is returning a confident
// number that is a ceiling, a floor, or a leftover from the previous gain.

import { test } from "node:test";
import assert from "node:assert/strict";

import { chipWithLight, bootStack } from "./fixtures/stack.mjs";

/** Start a driver on a chip with one light sensor, auto-ranging off. */
async function manual(options) {
  const { chip, sensor } = chipWithLight(options);
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "tsl2591", 0x29);
  await call("device_command", "tsl2591@0x29", "set_auto", [false]);
  return { call, sensor, poll: () => call("device_poll", "tsl2591@0x29") };
}

test("reads back the illuminance it was given", async () => {
  const { poll } = await manual({ lux: 250, infraredFraction: 0.25 });
  const state = await poll();

  // The emulator inverts the same equation the driver applies, so a round trip
  // has to land back where it started. A few percent covers the count being an
  // integer; anything worse is an arithmetic bug rather than quantisation.
  assert.ok(Math.abs(state.lux - 250) / 250 < 0.02, `got ${state.lux} lx`);
  assert.equal(state.saturated, false);
});

test("the same light reads the same at a different gain", async () => {
  // The whole purpose of folding gain and integration into the lux equation.
  // If it were wrong, every reading would still look plausible -- it would
  // just silently change by 25x when the range moved.
  const { call, poll } = await manual({ lux: 90, infraredFraction: 0.2 });
  const low = await poll();

  await call("device_command", "tsl2591@0x29", "set_gain", [0x20]); // 428x
  await call("device_command", "tsl2591@0x29", "set_integration", [3]); // 400 ms
  // The ADC has to finish an integration under the new settings first; reading
  // before that is the staleness the next test is about.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const high = await poll();

  assert.notEqual(low.gain, high.gain, "the range really did move");
  assert.ok(Math.abs(low.lux - high.lux) / low.lux < 0.05, `${low.lux} vs ${high.lux}`);
});

test("saturation is a reported state, not an exception", async () => {
  // adafruit_tsl2591.lux raises RuntimeError on overflow. A panel built on it
  // goes blank in bright light -- exactly when a reading is wanted -- so the
  // driver computes lux itself and flags the overflow instead.
  const { poll } = await manual({ lux: 60000, infraredFraction: 0.4 });
  const state = await poll();

  assert.equal(state.saturated, true);
  assert.ok(state.full >= state.fullScale, "channel 0 pinned at full scale");
  // And no lux, deliberately. The equation subtracts the infrared channel from
  // the visible one, so once both are pinned at the same value they cancel:
  // there is no lower bound left to quote, and quoting one would be inventing
  // it. The panel shows "over range" rather than a greyed-out number.
  assert.equal(state.lux, null, "no number, because there isn't one");
});

test("full scale at 100 ms is 36863, not 65535", async () => {
  // A datasheet quirk the library encodes and it would be easy to miss:
  // treating the 16-bit maximum as full scale at the shortest integration
  // means saturation is never detected there at all.
  const { call, poll } = await manual({ lux: 5000, infraredFraction: 0.3 });
  await call("device_command", "tsl2591@0x29", "set_integration", [0]);
  const short = await poll();
  assert.equal(short.fullScale, 36863);

  await call("device_command", "tsl2591@0x29", "set_integration", [1]);
  const longer = await poll();
  assert.equal(longer.fullScale, 65535);
});

test("auto-ranging escapes a saturated reading", async () => {
  const { chip } = chipWithLight({ lux: 12000, infraredFraction: 0.3 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "tsl2591", 0x29);

  // The library starts at 25x, which is hopeless in this much light.
  const first = await call("device_poll", "tsl2591@0x29");
  assert.equal(first.saturated, true, "starts over the top");

  // Poll until it settles, the same way the panel does. Bounded so a driver
  // that oscillates between two rungs fails here rather than spinning.
  let state = first;
  for (let i = 0; i < 12 && (state.saturated || state.settling); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = await call("device_poll", "tsl2591@0x29");
  }

  assert.equal(state.saturated, false, `still saturated: ${JSON.stringify(state.ranged)}`);
  assert.ok(state.gain < 25, `dropped the gain, got ${state.gain}x`);
  assert.ok(Math.abs(state.lux - 12000) / 12000 < 0.1, `ranged to ${state.lux} lx`);
});

test("brighter than the part can measure is said, not ranged around", async () => {
  // The ceiling is not a fixed lux figure -- it falls as the light gets more
  // infrared, because the equation subtracts that channel off. At 45 % IR the
  // least sensitive rung tops out below 40 klx, which direct sun clears.
  const { chip } = chipWithLight({ lux: 40000, infraredFraction: 0.45 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "tsl2591", 0x29);

  let state = await call("device_poll", "tsl2591@0x29");
  for (let i = 0; i < 12 && !state.atFloor; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = await call("device_poll", "tsl2591@0x29");
  }

  assert.equal(state.atFloor, true, "ran the ladder all the way down");
  assert.equal(state.saturated, true, "and is still over the top");
  assert.equal(state.gain, 1, "at the least sensitive rung there is");
  assert.equal(state.lux, null, "with nothing honest to report");
});

test("auto-ranging climbs out of the dark too", async () => {
  const { chip } = chipWithLight({ lux: 0.4, infraredFraction: 0.3 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "tsl2591", 0x29);

  let state = await call("device_poll", "tsl2591@0x29");
  for (let i = 0; i < 12 && (state.dark || state.settling); i++) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    state = await call("device_poll", "tsl2591@0x29");
  }

  assert.ok(state.gain > 25, `raised the gain, got ${state.gain}x`);
  assert.ok(state.fillFraction > 0.06, `used the converter, at ${state.fillFraction}`);
  assert.ok(Math.abs(state.lux - 0.4) / 0.4 < 0.2, `ranged to ${state.lux} lx`);
});

test("a reading taken straight after a range change is flagged, not trusted", async () => {
  // The ADC free-runs. Change the gain and the count still on offer was taken
  // under the old one -- so scaling it by the new gain gives a number wrong by
  // the ratio between them, which looks like the light changed.
  const { call } = await manual({ lux: 30, infraredFraction: 0.2 });
  await call("device_command", "tsl2591@0x29", "set_gain", [0x20]); // 25x -> 428x
  const immediate = await call("device_poll", "tsl2591@0x29");

  assert.equal(immediate.settling, true, "the driver knows this one is stale");
  // And it really would have been wrong: the count still on offer was taken at
  // 25x, so dividing it by 428 puts the reading about seventeen times low.
  assert.ok(immediate.lux < 10, `stale reading came out at ${immediate.lux} lx`);

  await new Promise((resolve) => setTimeout(resolve, 400));
  const settled = await call("device_poll", "tsl2591@0x29");
  assert.equal(settled.settling, false);
  assert.ok(Math.abs(settled.lux - 30) / 30 < 0.05, `settled at ${settled.lux} lx`);
});

test("one poll is one pair of channel reads", async () => {
  // lux, visible, infrared and full_spectrum each fetch both channels again,
  // so the obvious implementation costs four round trips and mixes readings
  // from different integrations.
  const { chip, sensor } = chipWithLight({ lux: 200 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "tsl2591", 0x29);
  await call("device_command", "tsl2591@0x29", "set_auto", [false]);

  sensor.channelReads = 0;
  const state = await call("device_poll", "tsl2591@0x29");

  // Channel 0 and channel 1, once each. Reading lux, visible, infrared and
  // full_spectrum as the library offers them would be eight.
  assert.equal(sensor.channelReads, 2, "one pair of channel reads per poll");
  assert.equal(state.visible, state.full - state.infrared);
});

test("the light source is classified from the channel ratio", async () => {
  const led = await manual({ lux: 400, infraredFraction: 0.05 });
  assert.equal((await led.poll()).source.kind, "led");

  const lamp = await manual({ lux: 400, infraredFraction: 0.5 });
  assert.equal((await lamp.poll()).source.kind, "daylight");
});

test("the sensor is found by a scan and matched to its panel", async () => {
  const { chip } = chipWithLight();
  const { call } = await bootStack({ chip });
  await call("connect");

  assert.deepEqual(await call("i2c_scan"), [0x29]);
});

test("closing the panel powers the part down", async () => {
  const { chip, sensor } = chipWithLight();
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "tsl2591", 0x29);
  assert.equal(sensor.enabled, true, "enabled by the constructor");

  await call("device_stop", "tsl2591@0x29");
  assert.equal(sensor.enabled, false, "and not left integrating afterwards");
});

// The AS7341, through the stock adafruit_as7341 library. The assertions worth
// making are about the two ways a spectral reading misleads: raw counts that
// move when only the settings moved, and channels pinned at full scale that
// still look like measurements.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Mcp2221Emulator } from "../../src/hid/mcp2221-emulator.ts";
import { VirtualWrongPart } from "../../src/hid/devices/rv1805.ts";
import { bootStack, chipWithSpectral } from "./fixtures/stack.mjs";

const open = async (options = {}) => {
  const rig = chipWithSpectral(options);
  const { call } = await bootStack({ chip: rig.chip });
  await call("connect");
  await call("device_start", "as7341", 0x39);
  return { ...rig, call, poll: () => call("device_poll", "as7341@0x39") };
};

test("reads all eight channels plus clear and near-IR", async () => {
  const { poll } = await open();
  const state = await poll();

  assert.equal(state.counts.length, 8);
  assert.deepEqual(state.wavelengths, [415, 445, 480, 515, 555, 590, 630, 680]);
  assert.ok(state.clear > 0, "clear should see something");
  assert.ok(state.nir > 0, "so should NIR");
});

test("the SMUX passes are not swapped", async () => {
  // The part has six ADCs for eleven diodes, so F1-F4 and F5-F8 arrive in two
  // passes through the same registers. Getting the passes the wrong way round
  // silently mirrors the spectrum and every number still looks plausible, so
  // the emulator derives the pass from the SMUX RAM the library wrote and this
  // pins the ordering with a shape nothing else could produce.
  const spectrum = [1, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.1];
  const { poll } = await open({ spectrum });
  const violetOnly = await poll();
  assert.ok(violetOnly.counts[0] > 0, "415 nm should be the lit one");
  assert.deepEqual(violetOnly.counts.slice(1), [0, 0, 0, 0, 0, 0, 0]);

  const red = [0, 0, 0, 0, 0, 0, 0, 1, 0.5, 0.1];
  const { poll: pollRed } = await open({ spectrum: red });
  const redOnly = await pollRed();
  assert.ok(redOnly.counts[7] > 0, "680 nm should be the lit one");
  assert.deepEqual(redOnly.counts.slice(0, 7), [0, 0, 0, 0, 0, 0, 0]);
});

test("basic counts survive a change of gain", async () => {
  // The whole point of the normalisation. Raw counts double when the gain
  // doubles even though the light has not changed; basic counts should not.
  const { call, poll } = await open();

  await call("device_command", "as7341@0x39", "set_gain", [4]); // 8x
  const low = await poll();
  await call("device_command", "as7341@0x39", "set_gain", [6]); // 32x
  const high = await poll();

  assert.ok(high.counts[4] > low.counts[4] * 3, "raw counts follow the gain");
  const ratio = high.basic[4] / low.basic[4];
  assert.ok(
    Math.abs(ratio - 1) < 0.02,
    `basic counts should be gain-independent, got a ratio of ${ratio.toFixed(3)}`,
  );
});

test("basic counts survive a change of integration time", async () => {
  const { call, poll } = await open();

  await call("device_command", "as7341@0x39", "set_integration", [50, 999]);
  const short = await poll();
  await call("device_command", "as7341@0x39", "set_integration", [200, 999]);
  const long = await poll();

  assert.ok(long.integrationMs > short.integrationMs * 3);
  assert.ok(long.counts[4] > short.counts[4] * 3, "raw counts follow the time");
  const ratio = long.basic[4] / short.basic[4];
  assert.ok(Math.abs(ratio - 1) < 0.02, `got a ratio of ${ratio.toFixed(3)}`);
});

test("saturation is reported rather than passed off as a reading", async () => {
  // Bright light and a large gain. A pinned channel reports full scale, which
  // is a perfectly reasonable-looking number and completely wrong.
  const { call, poll } = await open({ spectrum: [50, 50, 50, 50, 50, 50, 50, 50, 60, 20] });
  await call("device_command", "as7341@0x39", "set_gain", [10]); // 512x

  const state = await poll();
  assert.ok(state.saturated.some(Boolean), "should notice being pinned");
  for (const [i, hit] of state.saturated.entries()) {
    if (hit) assert.equal(state.counts[i], state.fullScale, "a pinned channel is at full scale");
  }
});

test("a dim scene saturates nothing", async () => {
  const { call, poll } = await open({ spectrum: [0.01, 0.02, 0.03, 0.04, 0.05, 0.04, 0.03, 0.02, 0.06, 0.01] });
  await call("device_command", "as7341@0x39", "set_gain", [1]); // 1x

  const state = await poll();
  assert.ok(state.saturated.every((hit) => !hit), JSON.stringify(state.counts));
  assert.equal(state.clearSaturated, false);
});

test("full scale follows the integration settings", async () => {
  const { call, poll } = await open();

  // (ATIME+1) x (ASTEP+1) below 65535 means the counter, not the ADC, is the limit.
  await call("device_command", "as7341@0x39", "set_integration", [9, 999]);
  const small = await poll();
  assert.equal(small.fullScale, 10 * 1000);

  await call("device_command", "as7341@0x39", "set_integration", [100, 999]);
  const large = await poll();
  assert.equal(large.fullScale, 65535, "capped by the 16-bit ADC");
});

test("integration time matches the datasheet's arithmetic", async () => {
  const { call, poll } = await open();
  await call("device_command", "as7341@0x39", "set_integration", [100, 999]);

  const state = await poll();
  // (100 + 1) x (999 + 1) x 2.78 us = 280.78 ms
  assert.ok(Math.abs(state.integrationMs - 280.78) < 0.1, `got ${state.integrationMs}`);
});

test("checks the WHOAMI rather than trusting the address", async () => {
  // 0x39 is shared -- an APDS-9960 sits there too -- so something answering is
  // not evidence that it is a spectral sensor.
  const chip = new Mcp2221Emulator();
  chip.attach(new VirtualWrongPart(0x39));
  const { call } = await bootStack({ chip });
  await call("connect");

  await assert.rejects(() => call("device_start", "as7341", 0x39));
});

test("closing the panel puts the illumination LED out", async () => {
  // It is bright, it is on someone's bench, and closing a tab should not leave
  // it lit.
  const { call } = await open();
  await call("device_command", "as7341@0x39", "set_led", [true, 10]);
  assert.equal((await call("device_poll", "as7341@0x39")).led, true);

  await call("device_stop", "as7341@0x39");
  await call("device_start", "as7341", 0x39);
  assert.equal((await call("device_poll", "as7341@0x39")).led, false);
});

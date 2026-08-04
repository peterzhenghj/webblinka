// The MCP2221's converter only reads a pin designated as an ADC. A channel
// whose pin is a GPIO still reports a number, and that number means nothing --
// so the Common tab has to know which of the three are actually analogue rather
// than showing all three all the time.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, demoChip } from "./fixtures/stack.mjs";

test("no channels are reported when no pin is an ADC", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");

  const status = await call("common_status");
  assert.deepEqual(
    status.adcChannels.map((c) => c.enabled),
    [false, false, false],
    "pins come up as GPIO, so nothing is connected to the converter",
  );
});

test("a channel appears exactly when its pin is designated an ADC", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  await call("gpio_configure", "G2", "analog_in");
  let channels = (await call("common_status")).adcChannels;
  assert.deepEqual(
    channels.filter((c) => c.enabled).map((c) => c.pin),
    ["G2"],
  );
  // Channel numbering is off-by-one from the pin: GP1 is channel 0.
  assert.equal(channels.find((c) => c.pin === "G2").channel, 1);

  await call("gpio_configure", "G3", "analog_in");
  channels = (await call("common_status")).adcChannels;
  assert.deepEqual(
    channels.filter((c) => c.enabled).map((c) => c.pin),
    ["G2", "G3"],
  );

  // Taking the pin back to GPIO retires its channel again.
  await call("gpio_configure", "G2", "output");
  channels = (await call("common_status")).adcChannels;
  assert.deepEqual(
    channels.filter((c) => c.enabled).map((c) => c.pin),
    ["G3"],
  );
});

test("common_status still carries everything the status report did", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");
  chip.setAdc(1, 700);
  await call("gpio_configure", "G2", "analog_in");

  const status = await call("common_status");
  assert.equal(status.adc.ch1, 700);
  assert.equal(status.revision.hardware, "A.6");
  assert.equal(status.i2c.stateName, "idle");
});

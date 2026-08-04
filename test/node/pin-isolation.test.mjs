// Blinka keeps the four GP configuration bytes in a cache and rewrites all of
// them on every designation change, because the Set SRAM command has no way to
// alter one pin alone. That makes "changing pin A disturbed pin B" a real
// software failure mode, and one worth ruling out before blaming the wiring
// when an ADC reading tracks a neighbouring output.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, demoChip } from "./fixtures/stack.mjs";

test("driving one pin does not disturb another pin's designation", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  await call("gpio_configure", "G3", "analog_in");
  await call("gpio_configure", "G2", "output");

  const adc = 0b010;
  assert.equal(chip.pinState(3).mode, adc, "G3 should still be an ADC");

  await call("gpio_write", "G2", 1);
  assert.equal(chip.pinState(3).mode, adc, "toggling G2 high must not redesignate G3");
  await call("gpio_write", "G2", 0);
  assert.equal(chip.pinState(3).mode, adc, "toggling G2 low must not redesignate G3");
});

test("an ADC reading does not follow a neighbouring output's level", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  // A steady voltage on the ADC channel. Channel 2 is GP3.
  chip.setAdc(2, 400);
  await call("gpio_configure", "G3", "analog_in");
  await call("gpio_configure", "G2", "output");

  await call("gpio_write", "G2", 1);
  const high = (await call("gpio_state", "G3")).value;
  await call("gpio_write", "G2", 0);
  const low = (await call("gpio_state", "G3")).value;

  // Any difference here would be ours: the emulator has no analogue world for
  // one pin to couple into another through.
  assert.equal(high, low, "the reading moved with G2, which no software should cause");
  assert.equal(high, 400 * 64, "and it should be the value the channel was given");
});

test("configuring a pin leaves the others' direction and level alone", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  await call("gpio_configure", "G0", "output");
  await call("gpio_write", "G0", 1);
  assert.equal(chip.pinState(0).value, 1);

  // Each of these rewrites all four config bytes from Blinka's cache.
  await call("gpio_configure", "G1", "analog_in");
  await call("gpio_configure", "G2", "analog_out");
  await call("gpio_configure", "G3", "analog_in");

  assert.equal(chip.pinState(0).value, 1, "G0 was driven low by someone else's change");
  assert.equal(chip.pinState(0).mode, 0b000, "G0 lost its GPIO designation");
  assert.equal(chip.pinState(0).direction, 0, "G0 stopped being an output");
});

test("the ADC reference is not disturbed by GPIO changes", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");

  await call("set_adc_reference", "2.048V", "Vrm");
  await call("gpio_configure", "G3", "analog_in");
  await call("gpio_configure", "G2", "output");
  await call("gpio_write", "G2", 1);

  // A moving reference would shift every channel at once, which is a different
  // fault from one pin coupling into another and worth being able to tell apart.
  const adc = (await call("sram_settings")).gp.adc;
  assert.equal(adc.referenceVoltage, "2.048V");
  assert.equal(adc.referenceOption, "Vrm");
});

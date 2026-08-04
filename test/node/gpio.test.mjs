// digitalio / analogio through Blinka against the emulated chip.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, demoChip } from "./fixtures/stack.mjs";

test("digital output round-trips through the chip", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  await call("gpio_configure", "G0", "output");
  await call("gpio_write", "G0", 1);
  assert.equal(chip.pinState(0).value, 1, "chip should see the high level");
  assert.deepEqual(await call("gpio_state", "G0"), { name: "G0", mode: "output", value: 1 });

  await call("gpio_write", "G0", 0);
  assert.equal(chip.pinState(0).value, 0);
  assert.deepEqual(await call("gpio_state", "G0"), { name: "G0", mode: "output", value: 0 });
});

test("digital input reads what the chip reports", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  await call("gpio_configure", "G1", "input");
  assert.equal((await call("gpio_state", "G1")).value, 0);
});

test("ADC reads scale to CircuitPython's 16-bit range", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  // Blinka multiplies the MCP2221's 10-bit reading by 64 to present the 16-bit
  // value CircuitPython's analogio contract promises.
  chip.setAdc(0, 0x3ff);
  await call("gpio_configure", "G1", "analog_in");
  assert.equal((await call("gpio_state", "G1")).value, 0x3ff * 64);

  chip.setAdc(0, 256);
  assert.equal((await call("gpio_state", "G1")).value, 256 * 64);
});

test("DAC writes land in the chip's 5-bit register", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  await call("gpio_configure", "G2", "analog_out");
  await call("gpio_write", "G2", 65535);
  assert.equal(chip.dac, 31, "65535 // 2048 saturates the 5-bit DAC");

  await call("gpio_write", "G2", 20480);
  assert.equal(chip.dac, 10);
});

test("a pin cannot be configured beyond its capabilities", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");

  await assert.rejects(() => call("gpio_configure", "G0", "analog_in"), /G0 cannot be analog_in/);
  await assert.rejects(() => call("gpio_configure", "G1", "analog_out"), /G1 cannot be analog_out/);
});

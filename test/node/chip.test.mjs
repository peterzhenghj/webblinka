// The MCP2221 features CircuitPython has no vocabulary for: status registers,
// GP designations beyond in/out, reference voltages, and the USB descriptors
// held in flash.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, demoChip } from "./fixtures/stack.mjs";

test("chip_status decodes the full status report", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  chip.setAdc(0, 512);
  chip.setAdc(1, 1023);
  chip.setAdc(2, 0);

  const status = await call("chip_status");
  assert.deepEqual(status.adc, { ch0: 512, ch1: 1023, ch2: 0 });
  assert.equal(status.i2c.stateName, "idle");
  assert.equal(status.i2c.acked, true);
  assert.equal(status.revision.hardware, "A.6");
  assert.equal(status.revision.firmware, "1.2");
  assert.equal(status.interruptEdgeDetected, false);
});

test("usb_descriptors reads the strings out of flash", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");

  const usb = await call("usb_descriptors");
  assert.equal(usb.manufacturer, "Microchip Technology Inc.");
  assert.equal(usb.product, "MCP2221 USB-I2C/UART Combo");
  assert.equal(usb.serialNumber, "0001020304");
  assert.equal(usb.factorySerialNumber, "01234567");
  assert.equal(usb.vendorId, 0x04d8);
  assert.equal(usb.productId, 0x00dd);
  assert.equal(usb.selfPowered, false);
  assert.equal(usb.remoteWake, true);
  assert.equal(usb.mARequested, 100);
  assert.equal(usb.chip.security, "unsecured");
});

test("dedicated designations reach the chip's GP settings", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  // These have no digitalio/analogio equivalent -- they are chip functions, set
  // by writing the designation and read back out of SRAM.
  await call("gpio_configure", "G0", "led_uart_rx");
  await call("gpio_configure", "G1", "clock_out");
  await call("gpio_configure", "G2", "usb_config");
  await call("gpio_configure", "G3", "led_i2c");

  assert.deepEqual(
    [0, 1, 2, 3].map((pin) => chip.pinState(pin).mode),
    [0b010, 0b001, 0b001, 0b001],
  );

  const sram = await call("sram_settings");
  assert.deepEqual(
    sram.pins.map((p) => p.designation),
    [0b010, 0b001, 0b001, 0b001],
  );
});

test("interrupt-on-change is a designation, and its latch clears", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  await call("gpio_configure", "G1", "interrupt");
  assert.equal(chip.pinState(1).mode, 0b100);

  chip.triggerInterrupt();
  assert.equal((await call("chip_status")).interruptEdgeDetected, true);

  await call("clear_interrupt");
  assert.equal((await call("chip_status")).interruptEdgeDetected, false);
});

test("clock output, references and interrupt edge round-trip through SRAM", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");

  assert.deepEqual(await call("set_clock_output", "25%", "375 kHz"), {
    dutyCycle: "25%",
    divider: "375 kHz",
  });

  const dac = await call("set_dac_reference", "4.096V", "Vrm");
  assert.equal(dac.referenceVoltage, "4.096V");
  assert.equal(dac.referenceOption, "Vrm");

  const adc = await call("set_adc_reference", "2.048V", "Vdd");
  assert.equal(adc.referenceVoltage, "2.048V");
  assert.equal(adc.referenceOption, "Vdd");

  assert.deepEqual(await call("set_interrupt_edge", "both"), { edge: "both" });
  assert.deepEqual(await call("set_interrupt_edge", "negative"), { edge: "negative" });

  // Setting the edge must not have disturbed the ADC reference, which shares
  // the same SRAM byte in the Get response.
  const after = await call("sram_settings");
  assert.equal(after.gp.adc.referenceVoltage, "2.048V");
  assert.deepEqual(after.gp.clock, { dutyCycle: "25%", divider: "375 kHz" });
});

test("set_dac_value writes the 5-bit register directly", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip });
  await call("connect");

  const dac = await call("set_dac_value", 21);
  assert.equal(dac.value, 21);
  assert.equal(chip.dac, 21);
});

test("gpio_modes lists what each pin can actually be", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");

  const modes = await call("gpio_modes");
  const names = (pin) => modes[pin].map((m) => m.mode);

  assert.deepEqual(names("G0"), ["input", "output", "sspnd", "led_uart_rx"]);
  assert.ok(names("G1").includes("interrupt"), "GP1 is the only interrupt pin");
  assert.ok(!names("G0").includes("analog_in"), "GP0 has no ADC");
  assert.ok(!names("G1").includes("analog_out"), "GP1 has no DAC");
  assert.equal(modes.G2.find((m) => m.mode === "analog_out").label, "DAC 1");
  assert.equal(modes.G3.find((m) => m.mode === "analog_in").label, "ADC 3");
});

test("gpio_read_all skips pins with nothing to read", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");

  await call("gpio_configure", "G0", "output");
  await call("gpio_configure", "G1", "clock_out");

  const states = await call("gpio_read_all");
  assert.deepEqual(
    states.map((s) => s.name),
    ["G0"],
    "a clock-output pin has no value to poll",
  );
  assert.equal((await call("gpio_state", "G1")).value, null);
});

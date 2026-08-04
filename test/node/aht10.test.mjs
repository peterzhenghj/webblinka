// The AHT10 driver, end to end: stock adafruit_ahtx0 against the emulated part,
// through Blinka and the hid shim.

import { test } from "node:test";
import assert from "node:assert/strict";

import { VirtualAht10 } from "../../src/hid/devices/aht10.ts";
import { bootStack, demoChipWithAht } from "./fixtures/stack.mjs";

test("reads temperature and humidity from the emulated sensor", async () => {
  // No self-heating, so the reading is exactly the ambient it was given.
  const chip = demoChipWithAht({ aht: { temperatureC: 24.5, relativeHumidity: 38, selfHeatC: 0 } });
  const { call } = await bootStack({ chip });
  await call("connect");

  await call("device_start", "aht10", 0x38);
  const state = await call("device_poll", "aht10@0x38");

  // The parts are packed into 20 bits over a 200 C and 100 % span, so the
  // quantisation is well under a thousandth of a unit -- anything worse than
  // this is a packing bug, not rounding.
  assert.ok(Math.abs(state.temperatureC - 24.5) < 0.01, `got ${state.temperatureC}`);
  assert.ok(Math.abs(state.relativeHumidity - 38) < 0.01, `got ${state.relativeHumidity}`);
  assert.ok(Math.abs(state.temperatureF - 76.1) < 0.05, `got ${state.temperatureF}`);
});

test("derives dew point and absolute humidity", async () => {
  const chip = demoChipWithAht({ aht: { temperatureC: 20, relativeHumidity: 50, selfHeatC: 0 } });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "aht10", 0x38);

  const state = await call("device_poll", "aht10@0x38");
  // 20 C at 50 % RH is a textbook 9.3 C dew point and about 8.6 g/m³.
  assert.ok(Math.abs(state.dewPointC - 9.3) < 0.2, `dew point ${state.dewPointC}`);
  assert.ok(Math.abs(state.absoluteHumidity - 8.65) < 0.2, `absolute ${state.absoluteHumidity}`);
  // The dew point is always at or below the dry-bulb temperature; above it
  // would mean supersaturated air and a sign error somewhere.
  assert.ok(state.dewPointC <= state.temperatureC);
});

test("saturated air has its dew point at the temperature", async () => {
  const chip = demoChipWithAht({ aht: { temperatureC: 12, relativeHumidity: 100, selfHeatC: 0 } });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "aht10", 0x38);

  const state = await call("device_poll", "aht10@0x38");
  assert.ok(Math.abs(state.dewPointC - 12) < 0.1, `dew point ${state.dewPointC}`);
});

test("one poll is one measurement, not two", async () => {
  const chip = demoChipWithAht();
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "aht10", 0x38);

  const sensor = chip.devices.find((d) => d.address === 0x38);
  sensor.commands.length = 0;
  await call("device_poll", "aht10@0x38");

  // Reading .temperature and then .relative_humidity would trigger twice and
  // return a pair taken a tenth of a second apart, at double the bus traffic.
  const triggers = sensor.commands.filter((c) => c === 0xac).length;
  assert.equal(triggers, 1, `expected one trigger, got ${triggers}`);
});

test("starting the driver resets and calibrates the part", async () => {
  const chip = demoChipWithAht();
  const { call } = await bootStack({ chip });
  await call("connect");

  const sensor = chip.devices.find((d) => d.address === 0x38);
  sensor.commands.length = 0;
  await call("device_start", "aht10", 0x38);

  assert.ok(sensor.commands.includes(0xba), "soft reset");
  assert.ok(
    sensor.commands.includes(0xe1) || sensor.commands.includes(0xbe),
    "calibrate, in either the AHT10 or AHT20 spelling",
  );
  // Calibration is checked by the library, so a part that never sets the flag
  // fails at start rather than reporting -50 C for ever.
  assert.equal((await call("device_poll", "aht10@0x38")).status & 0x08, 0x08);
});

test("the sensor is found by a scan and matched to its panel", async () => {
  const { call } = await bootStack({ chip: demoChipWithAht() });
  await call("connect");

  const found = await call("i2c_scan");
  assert.deepEqual(found, [0x10, 0x38], "the GPS and the AHT, in address order");
});

test("self-heating shows up as opposing drift", async () => {
  // Time is injected so the warm-up runs to completion without waiting for it.
  let clock = 0;
  const sensor = new VirtualAht10({
    temperatureC: 20,
    relativeHumidity: 50,
    selfHeatC: 2,
    now: () => clock,
  });
  const chip = demoChipWithAht();
  chip.attach(sensor);
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "aht10", 0x38);

  const warm = await call("device_poll", "aht10@0x38");
  clock += 10 * 60 * 1000; // ten minutes later it has settled
  const settled = await call("device_poll", "aht10@0x38");

  assert.ok(warm.temperatureC > settled.temperatureC, "a warm part reads high");
  assert.ok(
    warm.relativeHumidity < settled.relativeHumidity,
    "and low on humidity, because warmer air holds more water at the same absolute humidity",
  );
  // The water in the air did not change, only the sensor's opinion of it.
  assert.ok(Math.abs(settled.temperatureC - 20) < 0.05);
});

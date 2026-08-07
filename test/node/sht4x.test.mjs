// The SHT45 through the stock adafruit_sht4x library, and the shared
// hygrometry the AHT10 uses too. The assertions worth making are the heater --
// which is why this part has a filter and a panel -- and that the shared base
// really is shared rather than copied.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, chipWithSht4x, demoChipWithAht } from "./fixtures/stack.mjs";

const open = async (options = {}) => {
  const rig = chipWithSht4x(options);
  const { call } = await bootStack({ chip: rig.chip });
  await call("connect");
  await call("device_start", "sht4x", 0x44);
  return { ...rig, call, poll: () => call("device_poll", "sht4x@0x44") };
};

test("reads temperature and humidity through the CRC", async () => {
  // The library rejects a bad checksum outright, so getting a reading at all
  // proves the emulator's CRC-8 is right.
  const { poll } = await open({ temperatureC: 23.75, relativeHumidity: 38.5 });
  const state = await poll();

  assert.ok(Math.abs(state.temperatureC - 23.75) < 0.05, `got ${state.temperatureC}`);
  assert.ok(Math.abs(state.relativeHumidity - 38.5) < 0.05, `got ${state.relativeHumidity}`);
  assert.equal(state.label, "SHT4x");
});

test("reports its serial number", async () => {
  const { poll } = await open({ serial: 0x12345678 });
  const details = Object.fromEntries((await poll()).details.map((d) => [d.label, d.value]));
  assert.equal(details["Serial number"], "0x12345678");
});

test("the heater warms the die and depresses the humidity reading", async () => {
  // Both halves of what the heater does. The temperature rise is the cost; the
  // humidity drop is the mechanism that drives condensation off the filter.
  let clock = 0;
  const { call, poll, sensor } = await open({
    temperatureC: 20,
    relativeHumidity: 60,
    now: () => clock,
  });

  const before = await poll();
  await call("device_command", "sht4x@0x44", "heat", ["high_1s"]);
  const during = await poll();

  assert.ok(during.temperatureC > before.temperatureC + 0.5, "the die warms");
  assert.ok(during.relativeHumidity < before.relativeHumidity, "and reads drier");
  assert.ok(sensor.heatRiseC > 0);

  clock += 60_000; // a minute later it has cooled
  const after = await poll();
  assert.ok(Math.abs(after.temperatureC - 20) < 0.1, `should be back to ambient, got ${after.temperatureC}`);
});

test("a heat pulse leaves the part in its chosen precision", async () => {
  // The heater is fired by taking a measurement in a heat mode, so a driver
  // that forgot to put the mode back would leave the heater on every read.
  const { call, poll, sensor } = await open();
  await call("device_command", "sht4x@0x44", "set_precision", ["medium"]);
  sensor.commands.length = 0;

  await call("device_command", "sht4x@0x44", "heat", ["high_1s"]);
  await poll();

  // 0xf6 is medium precision, no heat. The last measurement command issued
  // must be that one, not a heater command.
  const measurements = sensor.commands.filter((c) => [0xfd, 0xf6, 0xe0, 0x39].includes(c));
  assert.equal(measurements.at(-1), 0xf6, `ended on ${measurements.at(-1)?.toString(16)}`);
});

test("the panel is told the heater has just run", async () => {
  const { call } = await open();
  const state = await call("device_command", "sht4x@0x44", "heat", ["high_1s"]);

  const heater = state.details.find((d) => d.label === "Heater");
  assert.ok(heater, "should raise a row about it");
  assert.equal(heater.tone, "warn");
  assert.match(heater.value, /not the air/, "and say the temperature is the die, not the room");
});

test("precision is selectable and reported", async () => {
  const { call, poll } = await open();
  await call("device_command", "sht4x@0x44", "set_precision", ["low"]);

  const state = await poll();
  const details = Object.fromEntries(state.details.map((d) => [d.label, d.value]));
  assert.match(details.Precision, /Low precision/);
  const select = state.controls.find((c) => c.kind === "select");
  assert.equal(select.value, "low", "and the control reflects it");
});

// ------------------------------------------------------- the shared ground

test("both parts derive the same physics from the same code", async () => {
  // The point of the refactor: one implementation of dew point and absolute
  // humidity, not two that drift apart.
  const { poll } = await open({ temperatureC: 20, relativeHumidity: 50 });
  const sht = await poll();

  const { call } = await bootStack({ chip: demoChipWithAht({ aht: { temperatureC: 20, relativeHumidity: 50, selfHeatC: 0 } }) });
  await call("connect");
  await call("device_start", "aht10", 0x38);
  const aht = await call("device_poll", "aht10@0x38");

  assert.ok(Math.abs(sht.dewPointC - aht.dewPointC) < 0.05, "same dew point");
  assert.ok(Math.abs(sht.absoluteHumidity - aht.absoluteHumidity) < 0.05, "same absolute humidity");
  // 20 C at 50 % RH is a textbook 9.3 C dew point.
  assert.ok(Math.abs(sht.dewPointC - 9.3) < 0.2, `got ${sht.dewPointC}`);
});

test("each part explains its own drift in its own terms", async () => {
  // The panel is generic, so the reason a reading might still be moving has to
  // come from the driver -- an AHT10 self-heats for minutes, an SHT45 does not.
  const { poll } = await open();
  assert.match((await poll()).settlingHint, /settles quickly/);

  const { call } = await bootStack({ chip: demoChipWithAht() });
  await call("connect");
  await call("device_start", "aht10", 0x38);
  assert.match((await call("device_poll", "aht10@0x38")).settlingHint, /self-heats/);
});

test("both parts drive the same panel through declared controls", async () => {
  const { poll } = await open();
  const shtControls = (await poll()).controls;
  assert.ok(shtControls.some((c) => c.kind === "select"), "precision");
  assert.ok(shtControls.some((c) => c.command === "heat"), "heater pulses");

  const { call } = await bootStack({ chip: demoChipWithAht() });
  await call("connect");
  await call("device_start", "aht10", 0x38);
  const ahtControls = (await call("device_poll", "aht10@0x38")).controls;
  assert.deepEqual(
    ahtControls.map((c) => c.command),
    ["reset"],
    "the AHT has one button and no modes",
  );
});

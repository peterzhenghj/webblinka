// The HDC3022 on the shared Hygrometer base -- the point being that adding it
// needed a driver and no UI at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, chipWithHdc302x } from "./fixtures/stack.mjs";

const open = async (options = {}) => {
  const rig = chipWithHdc302x(options);
  const { call } = await bootStack({ chip: rig.chip });
  await call("connect");
  await call("device_start", "hdc302x", 0x44);
  return { ...rig, call, poll: () => call("device_poll", "hdc302x@0x44") };
};

test("reads temperature and humidity through the CRC", async () => {
  const { poll } = await open({ temperatureC: 19.25, relativeHumidity: 55.5 });
  const state = await poll();
  assert.ok(Math.abs(state.temperatureC - 19.25) < 0.05, `got ${state.temperatureC}`);
  assert.ok(Math.abs(state.relativeHumidity - 55.5) < 0.05, `got ${state.relativeHumidity}`);
  assert.equal(state.label, "HDC302x");
});

test("it derives the same physics as every other hygrometer", async () => {
  const { poll } = await open({ temperatureC: 20, relativeHumidity: 50 });
  const state = await poll();
  assert.ok(Math.abs(state.dewPointC - 9.3) < 0.2, `got ${state.dewPointC}`);
  assert.ok(Math.abs(state.absoluteHumidity - 8.65) < 0.2, `got ${state.absoluteHumidity}`);
});

test("the heater latches, and the panel is told", async () => {
  // Unlike the SHT4x's timed pulses this one stays on, which is the thing to
  // get wrong: leave it lit and every later reading measures the die.
  let clock = 0;
  const { call, poll, sensor } = await open({ temperatureC: 20, now: () => clock });
  const cold = await poll();

  await call("device_command", "hdc302x@0x44", "set_heater", ["full"]);
  assert.equal(sensor.heaterOn, true);
  clock += 20_000;
  const warm = await poll();
  assert.ok(warm.temperatureC > cold.temperatureC + 1, "the die warms");

  const heater = warm.details.find((d) => d.label === "Heater");
  assert.ok(heater, "should raise a row");
  assert.equal(heater.tone, "warn");
  assert.match(heater.value, /not the air/);
});

test("closing the panel puts the heater out", async () => {
  // It latches, so a forgotten heater goes on warming long after the tab shut.
  const { call, sensor } = await open();
  await call("device_command", "hdc302x@0x44", "set_heater", ["half"]);
  assert.equal(sensor.heaterOn, true);

  await call("device_stop", "hdc302x@0x44");
  assert.equal(sensor.heaterOn, false);
});

test("it declares its own controls and its own settling story", async () => {
  const { poll } = await open();
  const state = await poll();

  const heater = state.controls.find((c) => c.command === "set_heater");
  assert.equal(heater.kind, "select", "a latching heater is a mode, not a pulse");
  assert.deepEqual(heater.options.map((o) => o.value), ["off", "quarter", "half", "full"]);
  assert.match(state.settlingHint, /settles quickly/);
});

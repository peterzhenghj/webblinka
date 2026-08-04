// The escape hatch: arbitrary Python against the live bus.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, demoChip } from "./fixtures/stack.mjs";

test("expressions evaluate against the live bus", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");
  await call("console_reset");

  // The namespace is pre-loaded with the real bus, and HID traffic works from
  // the console because it runs on the same stack-switching call as everything
  // else -- this scan is genuinely talking to the emulated chip.
  const scan = await call(
    "console_exec",
    "i2c.try_lock() and (i2c.scan(), i2c.unlock())[0]",
  );
  assert.equal(scan.error, null, scan.error ?? "");
  assert.equal(scan.result, "[16]");
});

test("statements keep state between calls", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");

  const assigned = await call("console_exec", "readings = [1, 2, 3]");
  assert.equal(assigned.error, null);
  assert.equal(assigned.result, null);

  const summed = await call("console_exec", "sum(readings)");
  assert.equal(summed.result, "6");
});

test("print output is captured, and errors come back as tracebacks", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");

  const printed = await call("console_exec", "print('hello from blinka')");
  assert.equal(printed.output, "hello from blinka\n");

  const broken = await call("console_exec", "1 / 0");
  assert.match(broken.error, /ZeroDivisionError/);
  assert.equal(broken.result, null);
});

test("console_reset exposes the CircuitPython names", async () => {
  const { call } = await bootStack({ chip: demoChip() });
  await call("connect");

  const names = await call("console_reset");
  for (const expected of ["board", "busio", "digitalio", "analogio", "i2c"]) {
    assert.ok(names.includes(expected), `expected ${expected} in ${names.join(", ")}`);
  }
});

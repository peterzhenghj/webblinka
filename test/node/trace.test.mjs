// The trace exists so a bug report from someone else's hardware carries the
// bytes, not just Python's traceback. Its formatting is therefore part of the
// contract, not incidental.

import { test } from "node:test";
import assert from "node:assert/strict";

import { HidTrace } from "../../src/hid/trace.ts";

/** hidapi puts the report ID at index 0; the trace should not show it. */
function report(...bytes) {
  return new Uint8Array([0x00, ...bytes]);
}

test("pairs each command with its reply and names the command", () => {
  const trace = new HidTrace();
  trace.wrote(report(0x90, 0x01, 0x00, 0x10));
  trace.read(new Uint8Array([0x90, 0x01, 0x25]));

  const text = trace.format();
  assert.match(text, /I2C_WRITE/);
  assert.match(text, /→ 90 01 00 10/);
  // The status byte and engine state are the whole point of capturing this.
  assert.match(text, /← 90 01 25/);
});

test("records a failed read rather than dropping the command", () => {
  const trace = new HidTrace();
  trace.wrote(report(0x10));
  trace.failed("no HID input report within 2000ms");

  const text = trace.format();
  assert.match(text, /STATUS/);
  assert.match(text, /!! no HID input report within 2000ms/);
});

test("keeps only the tail, so a 112-address scan stays readable", () => {
  const trace = new HidTrace();
  for (let address = 0; address < 200; address++) {
    trace.wrote(report(0x90, 0x00, 0x00, address << 1));
    trace.read(new Uint8Array([0x90, 0x00, 0x25]));
  }

  const text = trace.format(5);
  assert.match(text, /last 5 HID transfers/);
  assert.equal(text.split("\n").length, 11, "a header plus two lines per transfer");
});

test("says so plainly when there is nothing to report", () => {
  assert.equal(new HidTrace().format(), "(no HID traffic recorded)");
});

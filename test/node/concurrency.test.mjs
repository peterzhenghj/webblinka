// The MCP2221 has exactly one command pipeline and one I2C engine. Two Python
// calls in flight at once interleave their command/response pairs on that single
// pipeline, and each ends up reading the other's reply -- which surfaces as
// nonsense status bytes and Blinka's "Unrecoverable I2C state failure".
//
// This is easy to miss on the emulator, where a reply comes back in microseconds
// and the overlap window is tiny. Over real USB each transfer takes about a
// millisecond, so the very first concurrent poll corrupts the very first scan.
// The fixture below adds a delay to make the hardware's timing reproducible.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, demoChip } from "./fixtures/stack.mjs";

test("a poll running against a scan does not corrupt either", async () => {
  const chip = demoChip();
  // A millisecond per transfer, which is roughly what USB full-speed costs.
  const { call } = await bootStack({ chip, transferDelayMs: 1 });
  await call("connect");

  // Exactly what the UI does on connect: the Common tab starts polling status
  // at the same moment the I2C tab kicks off its first scan.
  const [scan, ...polls] = await Promise.all([
    call("i2c_scan"),
    call("chip_status"),
    call("chip_status"),
    call("chip_status"),
  ]);

  assert.deepEqual(scan, [0x10], "the scan must still find the GPS");
  for (const status of polls) {
    // The revision bytes are the canary: they sit at a fixed offset in the
    // status report and nowhere else, so reading anything but "A.6" means the
    // reply came from some other command.
    assert.equal(status.revision.hardware, "A.6", "a desynced read returns another command's bytes");
    assert.equal(status.revision.firmware, "1.2");
    // A poll interleaved with a scan legitimately catches the engine mid-probe
    // -- "address nack, stop" after an empty address is real state, not
    // corruption -- but it must always be a state the chip can actually be in.
    assert.ok(!status.i2c.stateName.startsWith("unknown"), status.i2c.stateName);
    assert.ok(status.adc.ch0 <= 1023, "ADC counts are 10-bit");
  }
});

test("interleaved reads and writes keep their own replies", async () => {
  const chip = demoChip();
  const { call } = await bootStack({ chip, transferDelayMs: 1 });
  await call("connect");
  await call("gpio_configure", "G0", "output");

  // Mixed traffic of different lengths, all issued at once.
  const results = await Promise.all([
    call("gpio_write", "G0", 1),
    call("usb_descriptors"),
    call("sram_settings"),
    call("chip_status"),
    call("gpio_write", "G0", 0),
    call("usb_descriptors"),
  ]);

  assert.equal(results[1].manufacturer, "Microchip Technology Inc.");
  assert.equal(results[5].manufacturer, "Microchip Technology Inc.");
  assert.equal(results[2].usb.vendorId, 0x04d8);
  assert.equal(results[3].revision.firmware, "1.2");
});

test("the transport reports no orphaned replies after concurrent work", async () => {
  const chip = demoChip();
  const { call, transport } = await bootStack({ chip, transferDelayMs: 1 });
  await call("connect");

  await Promise.all([call("i2c_scan"), call("chip_status"), call("sram_settings")]);

  // Every input report the chip sends answers a command. One left unread when
  // the next command goes out means the streams have crossed.
  assert.equal(transport.droppedReports, 0, "orphaned replies mean a desync happened");
});

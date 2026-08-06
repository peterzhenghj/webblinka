// Serial EEPROMs, and the two behaviours that make them bite: page wrap and the
// write cycle. Both are modelled in the virtual part, so a driver that gets
// them wrong fails here rather than on someone's bench.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, chipWithEeprom } from "./fixtures/stack.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const bytes = (b64s) => [...Buffer.from(b64s, "base64")];

test("reports the geometry of the part it was opened as", async () => {
  const { chip } = chipWithEeprom();
  const { call } = await bootStack({ chip });
  await call("connect");

  const info = await call("device_start", "at24c256", 0x50);
  assert.equal(info.info.size, 32768);
  assert.equal(info.info.pageSize, 64);
  assert.equal(info.info.addressBytes, 2);
  assert.equal(info.info.pages, 512);
});

test("round-trips bytes through a real write and read", async () => {
  const { chip, eeprom } = chipWithEeprom();
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "at24c256", 0x50);

  await call("device_command", "at24c256@0x50", "write", [0x0100, b64([1, 2, 3, 4, 5])]);
  assert.deepEqual([...eeprom.peek(0x0100, 5)], [1, 2, 3, 4, 5], "as seen from the part");

  const read = await call("device_command", "at24c256@0x50", "read", [0x0100, 5]);
  assert.deepEqual(bytes(read.data), [1, 2, 3, 4, 5], "and as read back over the bus");
});

test("a write across a page boundary lands where it should", async () => {
  const { chip, eeprom } = chipWithEeprom({ pageSize: 64 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "at24c256", 0x50);

  // Straddle the boundary at 0x40: sixteen bytes starting eight before it.
  const payload = Array.from({ length: 16 }, (_, i) => i + 1);
  await call("device_command", "at24c256@0x50", "write", [0x38, b64(payload)]);

  // Unsplit, the part would wrap the last eight bytes back to 0x00 and the
  // bytes at 0x40 would still be erased. Splitting is what makes this linear.
  assert.deepEqual([...eeprom.peek(0x38, 16)], payload, "contiguous across the boundary");
  assert.deepEqual([...eeprom.peek(0x00, 8)], Array(8).fill(0xff), "0x00 untouched");
});

test("the virtual part really does wrap, so the split is doing the work", async () => {
  // Guards the guard: if the emulator quietly accepted over-long page writes,
  // the test above would pass on a driver that corrupts real hardware.
  const { eeprom } = chipWithEeprom({ pageSize: 8, size: 256, addressBytes: 1 });
  eeprom.write(Uint8Array.from([0x04, 1, 2, 3, 4, 5, 6, 7, 8]));

  assert.deepEqual([...eeprom.peek(0x04, 4)], [1, 2, 3, 4], "up to the boundary");
  assert.deepEqual(
    [...eeprom.peek(0x00, 4)],
    [5, 6, 7, 8],
    "and the rest wrapped to the start of the same page",
  );
});

test("a long write is split into one transfer per page", async () => {
  const { chip, eeprom } = chipWithEeprom({ pageSize: 64 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "at24c256", 0x50);

  eeprom.writeCycles = 0;
  const payload = Array.from({ length: 200 }, (_, i) => i & 0xff);
  const result = await call("device_command", "at24c256@0x50", "write", [0, b64(payload)]);

  // 200 bytes from a page boundary is three full pages plus a remainder.
  assert.equal(result.pages, 4);
  assert.equal(eeprom.writeCycles, 4);
  assert.deepEqual([...eeprom.peek(0, 200)], payload);
});

test("the driver waits out the write cycle rather than assuming", async () => {
  // A part that NACKs for several probes after each write. A driver that just
  // slept a fixed time, or did not wait at all, would lose the next write.
  const { chip, eeprom } = chipWithEeprom({ busyProbes: 6 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "at24c256", 0x50);

  await call("device_command", "at24c256@0x50", "write", [0x10, b64([0xaa])]);
  await call("device_command", "at24c256@0x50", "write", [0x11, b64([0xbb])]);

  assert.deepEqual([...eeprom.peek(0x10, 2)], [0xaa, 0xbb]);
});

test("fill writes a run of one value", async () => {
  const { chip, eeprom } = chipWithEeprom();
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "at24c256", 0x50);

  await call("device_command", "at24c256@0x50", "fill", [0x80, 100, 0x5a]);
  assert.deepEqual([...eeprom.peek(0x80, 100)], Array(100).fill(0x5a));
  assert.equal(eeprom.peek(0x80 + 100, 1)[0], 0xff, "and stops where it was told");
});

test("reads longer than one I2C transfer are stitched together", async () => {
  const contents = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
  const { chip } = chipWithEeprom({ contents });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "at24c256", 0x50);

  // The MCP2221 caps a transfer at 60 bytes, so 256 is five of them.
  const read = await call("device_command", "at24c256@0x50", "read", [0, 256]);
  assert.deepEqual(bytes(read.data), [...contents.subarray(0, 256)]);
});

test("refuses to run off the end of the part", async () => {
  const { chip } = chipWithEeprom({ size: 4096 });
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "24lc32", 0x50);

  await assert.rejects(() => call("device_command", "24lc32@0x50", "read", [4090, 16]));
  await assert.rejects(() =>
    call("device_command", "24lc32@0x50", "write", [4090, b64([1, 2, 3, 4, 5, 6, 7, 8])]),
  );
});

test("a write-protected part reports it instead of silently doing nothing", async () => {
  const { chip, eeprom } = chipWithEeprom();
  eeprom.writeProtected = true;
  const { call } = await bootStack({ chip });
  await call("connect");
  await call("device_start", "at24c256", 0x50);

  await assert.rejects(() =>
    call("device_command", "at24c256@0x50", "write", [0, b64([0x42])]),
  );
  assert.equal(eeprom.peek(0, 1)[0], 0xff, "and nothing was written");
});

test("one address, several plausible parts", async () => {
  // These are indistinguishable on the bus, so the catalogue proposes all of
  // them and the geometry comes from whichever you pick.
  const { chip } = chipWithEeprom({ size: 4096, pageSize: 32 });
  const { call } = await bootStack({ chip });
  await call("connect");

  const small = await call("device_start", "24lc32", 0x50);
  assert.equal(small.info.size, 4096);
  const big = await call("device_start", "at24c512", 0x50);
  assert.equal(big.info.size, 65536);
});

// The AS5600, and the thing the panel exists for: an angle reading looks
// exactly as convincing with no magnet as with a well-placed one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootStack, chipWithEncoder } from "./fixtures/stack.mjs";

const open = async (options = {}) => {
  const rig = chipWithEncoder(options);
  const { call } = await bootStack({ chip: rig.chip });
  await call("connect");
  await call("device_start", "as5600", 0x36);
  return { ...rig, call, poll: () => call("device_poll", "as5600@0x36") };
};

test("reads the shaft angle", async () => {
  const { poll } = await open({ degrees: 90 });
  const state = await poll();
  assert.ok(Math.abs(state.rawDegrees - 90) < 0.2, `got ${state.rawDegrees}`);
  assert.ok(state.magnetDetected);
});

test("a missing magnet still yields a plausible angle, and is called out", async () => {
  // The whole reason the panel leads with magnet health: nothing about the
  // angle itself says it is noise.
  const { poll } = await open({ magnetAbsent: true, degrees: 210 });
  const state = await poll();

  assert.ok(state.degrees >= 0 && state.degrees < 360, "still a perfectly ordinary number");
  assert.equal(state.magnetDetected, false);
  assert.equal(state.magnet.state, "absent");
  assert.match(state.magnet.text, /noise/);
});

test("the gain reports which way the gap is wrong", async () => {
  // The chip raises the gain to compensate for a weaker field, so a saturated
  // reading at either end means the magnet is too far or too close.
  const far = await open({ gap: 1 });
  const farState = await far.poll();
  assert.equal(farState.magnet.state, "weak");
  assert.match(farState.magnet.text, /too far|too weak/);

  const near = await open({ gap: 0 });
  const nearState = await near.poll();
  assert.equal(nearState.magnet.state, "strong");
  assert.match(nearState.magnet.text, /too close|too strong/);

  const good = await open({ gap: 0.5 });
  assert.equal((await good.poll()).magnet.state, "ok");
});

test("turns accumulate across the wrap", async () => {
  // The chip wraps at 360 and has no idea how many times it has been round.
  const { encoder, poll } = await open({ degrees: 350 });
  await poll();

  encoder.rotate(20); // 350 -> 10, which is a wrap forwards not a leap back
  const forward = await poll();
  assert.equal(forward.turns, 1, "one turn");
  assert.ok(forward.continuousDegrees > 360, `got ${forward.continuousDegrees}`);

  encoder.rotate(-20); // and back again
  const back = await poll();
  assert.equal(back.turns, 0);
});

test("a big genuine movement is not mistaken for a wrap", async () => {
  const { encoder, poll } = await open({ degrees: 0 });
  await poll();
  encoder.rotate(100); // well under half a turn, so no wrap
  const state = await poll();
  assert.equal(state.turns, 0);
  assert.ok(Math.abs(state.continuousDegrees - 100) < 1, `got ${state.continuousDegrees}`);
});

test("zeroing shifts the scaled angle but not the raw one", async () => {
  const { call, poll } = await open({ degrees: 137 });
  const before = await poll();
  assert.ok(Math.abs(before.rawDegrees - 137) < 0.2);

  await call("device_command", "as5600@0x36", "set_zero_here", []);
  const after = await poll();

  assert.ok(after.degrees < 0.5 || after.degrees > 359.5, `should read zero, got ${after.degrees}`);
  assert.ok(Math.abs(after.rawDegrees - 137) < 0.2, "the shaft has not moved");
});

test("resetting turns does not disturb the angle", async () => {
  const { encoder, call, poll } = await open({ degrees: 350 });
  await poll();
  encoder.rotate(20);
  await poll();

  const reset = await call("device_command", "as5600@0x36", "reset_turns", []);
  assert.equal(reset.turns, 0);
  assert.ok(Math.abs(reset.rawDegrees - 10) < 1, `got ${reset.rawDegrees}`);
});

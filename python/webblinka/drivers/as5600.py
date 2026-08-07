"""AS5600 magnetic rotary position sensor, via the stock adafruit_as5600 library.

**An angle reading always looks fine.** The part will hand back a perfectly
plausible number between 0 and 360 degrees whether the magnet is at the right
distance, too far, too close, off-centre, or absent entirely -- in the last case
it is reporting noise, with no hint in the value itself. So the panel leads with
the magnet's health, and the driver reports the three status bits alongside the
automatic gain, which is the actual measure of how far away the magnet is: the
chip winds the gain up as the field weakens, so a figure pinned at either end
means the gap is wrong in one direction or the other.

**Turn counting is the driver's job, not the chip's.** The AS5600 wraps at 360
and has no idea how many times it has been round. Accumulating that is easy to
get wrong -- the give-away is a jump of more than half a revolution between two
readings, which is a wrap rather than a genuine movement -- and it is the thing
you actually want from a shaft encoder.
"""

from __future__ import annotations

import time
from typing import Any

from .base import Driver, register

DEFAULT_ADDRESS = 0x36

#: The angle registers are 12 bits, so a full turn is this many counts.
FULL_SCALE = 4096

#: A step larger than half a revolution between consecutive readings is a wrap,
#: not a movement. That holds as long as the shaft turns less than half a turn
#: between polls -- at the panel's rate, under about 150 rpm.
WRAP_THRESHOLD = FULL_SCALE // 2


@register("as5600")
class As5600(Driver):
    """ams AS5600 12-bit magnetic encoder."""

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._sensor = None
        self._turns = 0
        self._last_raw: int | None = None
        self._last_at: float | None = None
        self._speed_dps = 0.0

    def start(self) -> dict[str, Any]:
        import adafruit_as5600

        self._sensor = adafruit_as5600.AS5600(self.bus, address=self.address)
        self._reset_tracking()
        return {"address": self.address, "fullScale": FULL_SCALE}

    def stop(self) -> None:
        self._sensor = None

    def command(self, name: str, args: list[Any]) -> Any:
        sensor = self._require()
        if name == "set_zero_here":
            # ZPOS shifts the scaled angle so that wherever the shaft is now
            # reads zero. The raw angle is untouched, which is why the panel
            # shows both -- one is the shaft, the other is your choice of datum.
            sensor.z_position = sensor.raw_angle
            return self.poll()
        if name == "reset_turns":
            self._reset_tracking()
            return self.poll()
        return super().command(name, args)

    def poll(self) -> dict[str, Any]:
        sensor = self._require()
        now = time.monotonic()

        raw = sensor.raw_angle
        scaled = sensor.angle
        agc = sensor.agc

        # Accumulate turns from the *raw* angle: the scaled one moves when the
        # zero position is changed, which would look like a giant jump.
        if self._last_raw is not None:
            delta = raw - self._last_raw
            if delta > WRAP_THRESHOLD:
                self._turns -= 1
                delta -= FULL_SCALE
            elif delta < -WRAP_THRESHOLD:
                self._turns += 1
                delta += FULL_SCALE
            elapsed = now - (self._last_at or now)
            if elapsed > 0:
                degrees = delta * 360 / FULL_SCALE
                # Smoothed, because one poll's worth of quantisation over a
                # short interval is a wild speed. Two counts at 10 Hz is 17
                # degrees per second of pure noise.
                self._speed_dps = 0.7 * self._speed_dps + 0.3 * (degrees / elapsed)
        self._last_raw = raw
        self._last_at = now

        detected = bool(sensor.magnet_detected)
        too_weak = bool(sensor.max_gain_overflow)
        too_strong = bool(sensor.min_gain_overflow)

        return {
            "raw": raw,
            "scaled": scaled,
            "rawDegrees": raw * 360 / FULL_SCALE,
            "degrees": scaled * 360 / FULL_SCALE,
            "turns": self._turns,
            "continuousDegrees": self._turns * 360 + scaled * 360 / FULL_SCALE,
            "speedDps": self._speed_dps,
            "speedRpm": self._speed_dps / 6,
            "zeroPosition": sensor.z_position,
            "agc": agc,
            "magnitude": sensor.magnitude,
            "magnetDetected": detected,
            "magnetTooWeak": too_weak,
            "magnetTooStrong": too_strong,
            "magnet": _magnet_verdict(detected, too_weak, too_strong, agc),
        }

    def _reset_tracking(self) -> None:
        self._turns = 0
        self._last_raw = None
        self._last_at = None
        self._speed_dps = 0.0

    def _require(self):
        if self._sensor is None:
            raise RuntimeError("AS5600 not started")
        return self._sensor


def _magnet_verdict(
    detected: bool, too_weak: bool, too_strong: bool, agc: int
) -> dict[str, Any]:
    """What the status bits and the gain say about the magnet.

    The gain is the informative one. The chip raises it to compensate for a
    weaker field, so a high figure means the magnet is too far away and a low
    one means it is too close -- and either extreme means the gain has run out
    of room, which is what the ML and MH bits are reporting.
    """
    if not detected:
        return {
            "state": "absent",
            "tone": "error",
            "text": "No magnet detected — the angle below is noise, not a position.",
        }
    if too_weak:
        return {
            "state": "weak",
            "tone": "warn",
            "text": (
                f"Magnet too weak or too far (gain {agc} is at its ceiling). "
                "Move it closer, or use a stronger one."
            ),
        }
    if too_strong:
        return {
            "state": "strong",
            "tone": "warn",
            "text": (
                f"Magnet too strong or too close (gain {agc} has bottomed out). "
                "Move it further away."
            ),
        }
    return {
        "state": "ok",
        "tone": "ok",
        "text": f"Magnet in range, gain {agc}. Mid-range gain means a good gap.",
    }

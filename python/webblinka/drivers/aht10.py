"""AHT10 / AHT20 temperature and humidity, via the stock adafruit_ahtx0 library.

The physics -- dew point, absolute humidity, the shape of a reading -- lives in
`hygrometry`, shared with the SHT4x. What is particular to this part is that it
self-heats badly enough to matter.
"""

from __future__ import annotations

from typing import Any

from .base import register
from .hygrometry import Hygrometer

DEFAULT_ADDRESS = 0x38


@register("aht10")
class Ahtx0(Hygrometer):
    """Adafruit AHT10, AHT20, AHT21 and DHT20 breakouts."""

    LABEL = "AHT10 / AHT20"
    SETTLING_HINT = (
        "Still moving. An AHT10 self-heats, so it reads high on temperature "
        "and low on humidity for a minute or two after power-up or handling."
    )

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._sensor = None

    def start(self) -> dict[str, Any]:
        import adafruit_ahtx0

        # Constructing resets and calibrates the part, and raises if the
        # calibration flag never comes up -- so a sensor that is present but
        # unhappy fails here rather than quietly reporting -50 C for ever.
        self._sensor = adafruit_ahtx0.AHTx0(self.bus, address=self.address)
        return {"address": self.address, "label": self.LABEL}

    def stop(self) -> None:
        self._sensor = None

    def read(self) -> tuple[float, float]:
        sensor = self._require()
        # One measurement, both figures. Reading .temperature and then
        # .relative_humidity would trigger *two* separate conversions and return
        # a mismatched pair taken a tenth of a second apart -- and each costs a
        # trigger, a busy-poll and a six-byte read, which over HID is dozens of
        # transfers. _readdata fills both from a single conversion.
        sensor._readdata()  # noqa: SLF001 - no public spelling for "read both at once"
        return float(sensor._temp), float(sensor._humidity)  # noqa: SLF001

    def command(self, name: str, args: list[Any]) -> Any:
        if name == "reset":
            # A soft reset drops the calibration, so it has to be redone --
            # which is exactly what constructing the object does.
            self.start()
            return self.poll()
        return super().command(name, args)

    def details(self) -> list[dict[str, Any]]:
        return [
            {
                "label": "Status byte",
                "value": f"{self._require().status:#04x} · calibrated",
            }
        ]

    def controls(self) -> list[dict[str, Any]]:
        return [
            {
                "kind": "button",
                "command": "reset",
                "label": "Reset sensor",
                "args": [],
                "title": "Soft-reset and recalibrate. Also restarts the settling window.",
            }
        ]

    def _require(self):
        if self._sensor is None:
            raise RuntimeError("AHT not started")
        return self._sensor

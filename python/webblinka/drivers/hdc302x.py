"""TI HDC3022 and relatives, via the stock adafruit_hdc302x library.

Everything about reading it is `Hygrometer`, shared with the AHT10 and the
SHT4x. What is particular is a four-level heater, a NIST-traceable serial
number, and -- on the 3022 specifically -- the same reason the filtered SHT45
has one: an IP67 membrane keeps liquid off the polymer, and the heater drives
off what the membrane cannot.

Sits at 0x44 by default, which is also the SHT4x's, so the catalogue offers
both and the serial number is what tells you which you actually have.
"""

from __future__ import annotations

from typing import Any

from .base import register
from .hygrometry import Hygrometer

DEFAULT_ADDRESS = 0x44

#: The library's heater levels. Unlike the SHT4x's timed pulses these latch on
#: until switched off, so the panel offers them as a mode with an off.
HEATER_LEVELS = {
    "off": ("OFF", "Off"),
    "quarter": ("QUARTER_POWER", "Quarter power"),
    "half": ("HALF_POWER", "Half power"),
    "full": ("FULL_POWER", "Full power"),
}


@register("hdc302x")
class Hdc302x(Hygrometer):
    """HDC3020, HDC3021 and the filtered HDC3022."""

    LABEL = "HDC302x"
    SETTLING_HINT = (
        "Still moving. This part settles quickly, so a drifting reading is "
        "usually the air — unless the heater is on, in which case the "
        "temperature is the die and not the room."
    )

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._sensor = None
        self._heater = "off"

    def start(self) -> dict[str, Any]:
        import adafruit_hdc302x

        self._sensor = adafruit_hdc302x.HDC302x(self.bus, address=self.address)
        # Whatever a previous session left on, the panel should start from a
        # part that is measuring the air rather than its own heater.
        self._set_heater("off")
        return {"address": self.address, "label": self.LABEL}

    def stop(self) -> None:
        # The heater latches on this part, so leaving it lit would go on
        # warming the die long after the tab closed.
        if self._sensor is not None:
            try:
                self._set_heater("off")
            except Exception:  # noqa: BLE001 - the part may already be gone
                pass
        self._sensor = None

    def read(self) -> tuple[float, float]:
        temperature, humidity = self._require().measurements
        return float(temperature), float(humidity)

    def command(self, name: str, args: list[Any]) -> Any:
        if name == "set_heater":
            self._set_heater(str(args[0]))
            return self.poll()
        return super().command(name, args)

    def _set_heater(self, level: str) -> None:
        self._heater = level if level in HEATER_LEVELS else "off"
        self._require().heater = HEATER_LEVELS[self._heater][0]

    def details(self) -> list[dict[str, Any]]:
        sensor = self._require()
        rows = [
            {"label": "Manufacturer", "value": f"{sensor.manufacturer_id:#06x}"},
            {"label": "Serial", "value": "".join(f"{w:04x}" for w in sensor.nist_id)},
        ]
        if self._heater != "off":
            rows.append(
                {
                    "label": "Heater",
                    "value": (
                        f"{HEATER_LEVELS[self._heater][1].lower()} — the temperature "
                        "is the die, not the air"
                    ),
                    "tone": "warn",
                }
            )
        return rows

    def controls(self) -> list[dict[str, Any]]:
        return [
            {
                "kind": "select",
                "command": "set_heater",
                "label": "Heater",
                "value": self._heater,
                "options": [{"value": k, "label": v[1]} for k, v in HEATER_LEVELS.items()],
                "title": (
                    "Drives condensation off the membrane and resets the polymer's "
                    "creep after a long soak. Unlike the SHT4x's timed pulses this "
                    "latches on, so the temperature stays unusable until it is off."
                ),
            }
        ]

    def _require(self):
        if self._sensor is None:
            raise RuntimeError("HDC302x not started")
        return self._sensor

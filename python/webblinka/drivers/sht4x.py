"""Sensirion SHT4x: the SHT45 with its PTFE filter, and its plainer relatives.

Everything about reading it is in `Hygrometer`; what is particular to this part
is a precision setting, a serial number, and a heater.

**The heater is the reason this part has a filter and a panel worth having.**
The PTFE cap keeps liquid and dust off the sensing polymer, but once the air
has been near saturation for a while the polymer holds onto water and reads
high afterwards -- Sensirion call it creep -- and actual condensation on the
filter pins the reading near 100% until it clears. A short heat pulse drives
both off. It also, unavoidably, warms the die: the temperature reading is
rubbish for a few seconds afterwards and the panel says so rather than letting
someone read a number that is measuring the heater.
"""

from __future__ import annotations

from typing import Any

from .base import register
from .hygrometry import Hygrometer, sleep

DEFAULT_ADDRESS = 0x44

#: Mode command byte to a human name, from the library's own table. The three
#: no-heat modes trade precision against how long the measurement takes; the
#: heater modes are pulses, not a setting to leave switched on.
PRECISIONS = {
    "high": ("NOHEAT_HIGHPRECISION", "High precision (8.2 ms)"),
    "medium": ("NOHEAT_MEDPRECISION", "Medium precision (4.5 ms)"),
    "low": ("NOHEAT_LOWPRECISION", "Low precision (1.7 ms)"),
}

#: Heater pulses. Sensirion cap the duty cycle at 5% of the time, which at one
#: second a pulse means leaving twenty seconds between them -- so these are
#: offered as one-shot actions rather than a mode you can select and forget.
HEAT_PULSES = {
    "high_1s": ("HIGHHEAT_1S", "200 mW for 1 s"),
    "high_100ms": ("HIGHHEAT_100MS", "200 mW for 0.1 s"),
    "medium_1s": ("MEDHEAT_1S", "110 mW for 1 s"),
    "low_1s": ("LOWHEAT_1S", "20 mW for 1 s"),
}

#: How long the temperature reading stays contaminated after a pulse. The
#: datasheet does not put a number on the settling; this is deliberately
#: generous, and the panel counts it down rather than pretending it is exact.
HEAT_RECOVERY_S = 15.0


@register("sht4x")
class Sht4x(Hygrometer):
    """SHT45, SHT43, SHT41 and SHT40 -- the same die at different grades."""

    LABEL = "SHT4x"
    SETTLING_HINT = (
        "Still moving. This part settles quickly, so a drifting reading is "
        "usually the air rather than the sensor — unless the heater has just "
        "run, in which case it is the die cooling back down."
    )

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._sensor = None
        self._precision = "high"
        self._heated_at: float | None = None

    def start(self) -> dict[str, Any]:
        import adafruit_sht4x

        self._sensor = adafruit_sht4x.SHT4x(self.bus, address=self.address)
        self._apply_precision()
        return {"address": self.address, "label": self.LABEL, **self._identity()}

    def stop(self) -> None:
        self._sensor = None

    def read(self) -> tuple[float, float]:
        # One command returns both, checksummed, so there is no risk of a
        # mismatched pair and no reason to ask twice.
        temperature, humidity = self._require().measurements
        return float(temperature), float(humidity)

    def command(self, name: str, args: list[Any]) -> Any:
        if name == "set_precision":
            self._precision = str(args[0])
            self._apply_precision()
            return self.poll()
        if name == "heat":
            return self._heat(str(args[0]))
        if name == "reset":
            self._require().reset()
            self._apply_precision()
            return self.poll()
        return super().command(name, args)

    def _heat(self, pulse: str) -> dict[str, Any]:
        import adafruit_sht4x

        name = HEAT_PULSES.get(pulse, HEAT_PULSES["high_1s"])[0]
        sensor = self._require()
        sensor.mode = getattr(adafruit_sht4x.Mode, name)
        # The heater runs during a measurement, so taking one is how you fire
        # the pulse. Its result is discarded: it is a reading of the heater.
        sensor.measurements
        sensor.mode = getattr(adafruit_sht4x.Mode, PRECISIONS[self._precision][0])
        # Let the worst of it pass before the panel's next poll lands.
        sleep(0.2)
        self._heated_at = _now()
        return self.poll()

    def _apply_precision(self) -> None:
        import adafruit_sht4x

        name = PRECISIONS.get(self._precision, PRECISIONS["high"])[0]
        self._require().mode = getattr(adafruit_sht4x.Mode, name)

    def _identity(self) -> dict[str, Any]:
        # A real serial number, so "something is at 0x44" becomes "this part is
        # there". 0x44 is shared -- an SHT31 or an HTU31 answers there too --
        # but those do not speak this protocol, so a bad CRC or a nonsense
        # serial is the signal.
        serial = self._require().serial_number
        return {"serial": f"{serial:#010x}"}

    def details(self) -> list[dict[str, Any]]:
        rows = [
            {"label": "Serial number", "value": self._identity()["serial"]},
            {"label": "Precision", "value": PRECISIONS[self._precision][1]},
        ]
        remaining = self._heat_recovery_remaining()
        if remaining > 0:
            rows.append(
                {
                    "label": "Heater",
                    "value": (
                        f"just ran — temperature is the die cooling for another "
                        f"{remaining:.0f} s, not the air"
                    ),
                    "tone": "warn",
                }
            )
        return rows

    def controls(self) -> list[dict[str, Any]]:
        return [
            {
                "kind": "select",
                "command": "set_precision",
                "label": "Precision",
                "value": self._precision,
                "options": [{"value": k, "label": v[1]} for k, v in PRECISIONS.items()],
                "title": "Longer measurements are quieter. All three are fast enough here.",
            },
            *[
                {
                    "kind": "button",
                    "command": "heat",
                    "label": f"Heat {label}",
                    "args": [key],
                    "title": (
                        "Drives condensation off the PTFE filter and resets the "
                        "polymer's creep after a long soak at high humidity. "
                        "Warms the die, so the temperature reading is unusable "
                        "for a few seconds afterwards. Sensirion cap the heater "
                        "at 5% duty — leave twenty seconds between one-second "
                        "pulses."
                    ),
                }
                for key, (_, label) in HEAT_PULSES.items()
            ],
            {
                "kind": "button",
                "command": "reset",
                "label": "Soft reset",
                "args": [],
                "title": "Restarts the sensor and reapplies the precision setting.",
            },
        ]

    def _heat_recovery_remaining(self) -> float:
        if self._heated_at is None:
            return 0.0
        return max(0.0, HEAT_RECOVERY_S - (_now() - self._heated_at))

    def _require(self):
        if self._sensor is None:
            raise RuntimeError("SHT4x not started")
        return self._sensor


def _now() -> float:
    import time

    return time.monotonic()

"""AHT10 / AHT20 temperature and humidity, via the stock adafruit_ahtx0 library.

The sensor reports temperature and relative humidity. What people usually want
from those two is a third number the part does not measure -- the dew point --
so the driver derives it here rather than leaving it to the panel: it is physics
rather than presentation, and getting it right once is better than twice.
"""

from __future__ import annotations

import math
from typing import Any

from .base import Driver, register

DEFAULT_ADDRESS = 0x38

# Magnus-Tetens coefficients over water, good to about 0.1 degrees across the
# range this sensor covers (-40 to +85 C). Below freezing the coefficients over
# ice differ, but the AHT10's own accuracy is +/-0.3 C, so the distinction is
# well below the noise.
MAGNUS_A = 17.625
MAGNUS_B = 243.04


@register("aht10")
class Ahtx0(Driver):
    """Adafruit AHT10, AHT20, AHT21 and DHT20 breakouts."""

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._sensor = None

    def start(self) -> dict[str, Any]:
        import adafruit_ahtx0

        # Constructing resets and calibrates the part, and raises if the
        # calibration flag never comes up -- so a sensor that is present but
        # unhappy fails here rather than quietly reporting -50 C for ever.
        self._sensor = adafruit_ahtx0.AHTx0(self.bus, address=self.address)
        return {"address": self.address}

    def stop(self) -> None:
        self._sensor = None

    def command(self, name: str, args: list[Any]) -> Any:
        if name == "reset":
            # A soft reset drops the calibration, so it has to be redone --
            # which is exactly what constructing the object does.
            return self.start()
        return super().command(name, args)

    def poll(self) -> dict[str, Any]:
        sensor = self._require()

        # One measurement, both figures. Reading .temperature and then
        # .relative_humidity would trigger *two* separate conversions and return
        # a mismatched pair taken a tenth of a second apart -- and each costs a
        # trigger, a busy-poll and a six-byte read, which over HID is dozens of
        # transfers. _readdata fills both from a single conversion.
        sensor._readdata()  # noqa: SLF001 - no public spelling for "read both at once"
        temperature_c = float(sensor._temp)  # noqa: SLF001
        humidity = float(sensor._humidity)  # noqa: SLF001

        return {
            "temperatureC": temperature_c,
            "temperatureF": temperature_c * 9 / 5 + 32,
            "relativeHumidity": humidity,
            "dewPointC": _dew_point_c(temperature_c, humidity),
            "absoluteHumidity": _absolute_humidity(temperature_c, humidity),
            "status": sensor.status,
        }

    def _require(self):
        if self._sensor is None:
            raise RuntimeError("AHT not started")
        return self._sensor


def _dew_point_c(temperature_c: float, relative_humidity: float) -> float | None:
    """The temperature at which this air would start condensing.

    Undefined at zero humidity -- the logarithm diverges -- and a reading of
    exactly zero means the sensor is not working rather than that the air is
    perfectly dry, so it returns None instead of negative infinity.
    """
    if relative_humidity <= 0:
        return None
    gamma = math.log(relative_humidity / 100) + (MAGNUS_A * temperature_c) / (
        MAGNUS_B + temperature_c
    )
    return (MAGNUS_B * gamma) / (MAGNUS_A - gamma)


def _absolute_humidity(temperature_c: float, relative_humidity: float) -> float:
    """Grams of water per cubic metre.

    Worth having alongside relative humidity because the relative figure moves
    when the temperature moves even though the amount of water has not changed
    -- which is precisely what self-heating does to this sensor, and why a
    falling humidity reading on a warming part is not the room drying out.
    """
    saturation_pressure = 6.112 * math.exp(
        (MAGNUS_A * temperature_c) / (MAGNUS_B + temperature_c)
    )
    vapour_pressure = saturation_pressure * (relative_humidity / 100)
    # Constant folds the molar mass of water and the gas constant together;
    # 216.7 = 100 * M_w / R with pressure in hPa and temperature in kelvin.
    return (216.7 * vapour_pressure) / (273.15 + temperature_c)

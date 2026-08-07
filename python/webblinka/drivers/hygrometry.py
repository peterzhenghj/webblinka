"""Shared ground for temperature and humidity sensors.

Every part of this kind reports the same two numbers and invites the same three
derived ones, so the physics lives here once and a driver supplies only what is
particular to its silicon: how to take a reading, what to call itself, and which
knobs it has.

The derived figures are not decoration. Relative humidity moves when the
temperature moves even though the water in the air has not, so a falling RH on
a warming sensor is not the room drying out -- absolute humidity says which it
is. And the dew point is the number you actually want if you care whether
anything is about to get wet, which the part does not measure at all.
"""

from __future__ import annotations

import math
import time
from typing import Any

from .base import Driver

# Magnus-Tetens coefficients over water, good to about 0.1 degrees across the
# range these parts cover. Below freezing the coefficients over ice differ, but
# by less than the sensors' own accuracy.
MAGNUS_A = 17.625
MAGNUS_B = 243.04


def dew_point_c(temperature_c: float, relative_humidity: float) -> float | None:
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


def absolute_humidity(temperature_c: float, relative_humidity: float) -> float:
    """Grams of water per cubic metre."""
    saturation_pressure = 6.112 * math.exp(
        (MAGNUS_A * temperature_c) / (MAGNUS_B + temperature_c)
    )
    vapour_pressure = saturation_pressure * (relative_humidity / 100)
    # 216.7 folds the molar mass of water and the gas constant together, with
    # pressure in hPa and temperature in kelvin.
    return (216.7 * vapour_pressure) / (273.15 + temperature_c)


class Hygrometer(Driver):
    """Base for temperature and humidity sensors."""

    LABEL = "Hygrometer"
    #: Why a reading might still be moving, in this part's own terms. Shown
    #: while the trend says it has not settled.
    SETTLING_HINT = ""

    def read(self) -> tuple[float, float]:
        """Temperature in Celsius and relative humidity, from one measurement."""
        raise NotImplementedError

    def controls(self) -> list[dict[str, Any]]:
        """Knobs this part has, rendered by the panel without knowing the part."""
        return []

    def details(self) -> list[dict[str, Any]]:
        """Extra rows worth showing: identity, mode, whatever the part offers."""
        return []

    def poll(self) -> dict[str, Any]:
        temperature_c, humidity = self.read()
        return {
            "label": self.LABEL,
            "temperatureC": temperature_c,
            "temperatureF": temperature_c * 9 / 5 + 32,
            "relativeHumidity": humidity,
            "dewPointC": dew_point_c(temperature_c, humidity),
            "absoluteHumidity": absolute_humidity(temperature_c, humidity),
            "settlingHint": self.SETTLING_HINT,
            "controls": self.controls(),
            "details": self.details(),
        }


def sleep(seconds: float) -> None:
    """A yielding sleep, so a heater pulse does not stall the worker."""
    time.sleep(seconds)

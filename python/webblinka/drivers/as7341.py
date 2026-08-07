"""AS7341 11-channel spectral sensor, via the stock adafruit_as7341 library.

Eight visible channels from 415 to 680 nm, plus clear and near-IR. The part has
only six ADCs, so the library routes the photodiodes through the chip's SMUX in
two passes -- which is why one reading costs two full integrations and this is
not a sensor to poll quickly.

**Raw counts on their own mean nothing.** They scale with the gain and with how
long the sensor integrated, so two readings taken at different settings cannot
be compared, and a spectrum plotted from raw counts changes shape when you
change the gain even though the light did not. The fix is the normalisation
ams's own application notes use -- basic counts, raw over gain times
integration time in milliseconds -- so the driver reports both and the panel
plots the normalised one.

**Saturation is the other trap.** A channel at full scale is reporting a floor,
not a measurement, and the shape of the spectrum around it is a lie. It looks
like a perfectly good number. So the driver computes full scale from the
integration settings and says which channels have hit it.
"""

from __future__ import annotations

from typing import Any

from .base import Driver, register

DEFAULT_ADDRESS = 0x39

#: Centre wavelength of each of the eight spectral channels, in nanometres.
WAVELENGTHS = (415, 445, 480, 515, 555, 590, 630, 680)

#: One ADC step is 2.78 microseconds. Integration time is
#: (ATIME + 1) x (ASTEP + 1) x 2.78 us, which is what both the datasheet and
#: the library's defaults are expressed in terms of.
STEP_US = 2.78

#: The ADC counter is 16 bits, so however long it integrates for it cannot
#: report more than this.
ADC_MAX = 65535

#: Gain register value to multiplier, from the library's own table.
GAIN_MULTIPLIERS = {i: 0.5 * (2**i) for i in range(11)}


@register("as7341")
class As7341(Driver):
    """Adafruit AS7341 breakout and other ams AS7341 boards."""

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._sensor = None

    def start(self) -> dict[str, Any]:
        import adafruit_as7341

        # The constructor checks the WHOAMI, so a different part at 0x39 fails
        # here rather than returning plausible-looking spectra.
        self._sensor = adafruit_as7341.AS7341(self.bus, address=self.address)
        return {"address": self.address, "wavelengths": list(WAVELENGTHS), **self._settings()}

    def stop(self) -> None:
        if self._sensor is not None:
            # Leave the illumination LED off. It is bright, it is on someone's
            # bench, and closing the panel should not leave it lit.
            try:
                self._sensor.led = False
            except Exception:  # noqa: BLE001 - the part may already be gone
                pass
        self._sensor = None

    def command(self, name: str, args: list[Any]) -> Any:
        sensor = self._require()
        if name == "set_gain":
            sensor.gain = int(args[0])
            return self._settings()
        if name == "set_integration":
            # ATIME and ASTEP trade the same thing -- total integration time --
            # against each other, so both are exposed rather than a single
            # "exposure" that hides which knob moved.
            sensor.atime = int(args[0])
            sensor.astep = int(args[1])
            return self._settings()
        if name == "set_led":
            # Current first: setting it while the LED is off avoids a flash at
            # whatever the previous current was.
            if len(args) > 1 and args[1] is not None:
                sensor.led_current = int(args[1])
            sensor.led = bool(args[0])
            return self._settings()
        return super().command(name, args)

    def poll(self) -> dict[str, Any]:
        sensor = self._require()

        # Two SMUX passes behind this one property. Everything else is read
        # from the same pair of integrations rather than triggering more.
        channels = list(sensor.all_channels)
        clear = sensor.channel_clear
        nir = sensor.channel_nir

        settings = self._settings()
        full_scale = settings["fullScale"]
        divisor = settings["gain"] * settings["integrationMs"]

        def basic(count: int) -> float:
            return count / divisor if divisor else 0.0

        return {
            **settings,
            "wavelengths": list(WAVELENGTHS),
            "counts": channels,
            "basic": [basic(c) for c in channels],
            "clear": clear,
            "nir": nir,
            "clearBasic": basic(clear),
            "nirBasic": basic(nir),
            # A channel at full scale is a floor, not a reading, and the shape
            # of the spectrum either side of it cannot be trusted either.
            "saturated": [c >= full_scale for c in channels],
            "clearSaturated": clear >= full_scale,
        }

    def _settings(self) -> dict[str, Any]:
        sensor = self._require()
        atime = sensor.atime
        astep = sensor.astep
        steps = (atime + 1) * (astep + 1)
        return {
            "gainRegister": sensor.gain,
            "gain": GAIN_MULTIPLIERS.get(sensor.gain, 1.0),
            "atime": atime,
            "astep": astep,
            "integrationMs": steps * STEP_US / 1000,
            "fullScale": min(ADC_MAX, steps),
            "led": bool(getattr(sensor, "_led_current_bits", 0) >= 0) and sensor.led,
            "ledCurrent": _led_current(sensor),
            "gains": [{"register": r, "multiplier": m} for r, m in GAIN_MULTIPLIERS.items()],
        }

    def _require(self):
        if self._sensor is None:
            raise RuntimeError("AS7341 not started")
        return self._sensor


def _led_current(sensor) -> int:
    """The LED drive current in mA, or 0 when the library will not say."""
    try:
        return int(sensor.led_current)
    except Exception:  # noqa: BLE001 - not all boards wire the LED up
        return 0

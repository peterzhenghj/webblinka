"""TSL2591 high-dynamic-range light sensor, via the stock adafruit_tsl2591 library.

The part's selling point is six orders of magnitude of range, from a moonlit
room to direct sun. It does not get there on its own: that range exists only if
the gain and the integration time are right for the light, and the two knobs
together span a factor of about sixty thousand. Choosing them is the actual work
of using this sensor, so the driver does it.

**The library's ``lux`` raises on overflow.** Point a panel that reads it in a
loop at a window and the panel goes blank -- at exactly the moment you most want
a number. Worse, the exception says to lower the gain, which is advice, not a
fix. So this driver reads the two raw channels itself and applies the library's
own formula, which turns saturation from an exception into a state the panel can
draw: this reading is over the top, the converter is full, here is the range it
moved to. What it does *not* do is invent a number to put there. Once both
channels clip there is no lower bound to recover -- the equation subtracts
infrared from visible, and two equal pinned counts cancel -- so the lux is
reported as absent rather than as a floor.

**Every convenience property is a separate bus read.** ``lux``, ``visible``,
``infrared`` and ``full_spectrum`` each fetch both channels again, so the
obvious poll costs four round trips and mixes readings from different ADC
cycles. One ``raw_luminosity`` read backs everything reported here.

**A settings change does not take effect until the next full integration.** The
ADC is free-running; read it immediately after moving the gain and you get a
count from the old setting, scaled as though it were the new one -- which looks
like a real measurement and is off by whatever the ratio was. Every change here
starts a settling window, and readings taken inside it are flagged rather than
reported as fact.
"""

from __future__ import annotations

import time
from typing import Any

from .base import Driver, register

DEFAULT_ADDRESS = 0x29

#: Gain register value to multiplier. The register holds these in bits 4-5.
GAINS: dict[int, float] = {0x00: 1.0, 0x10: 25.0, 0x20: 428.0, 0x30: 9876.0}

#: Integration time register value (0-5) to milliseconds.
INTEGRATION_MS: dict[int, float] = {i: 100.0 * i + 100.0 for i in range(6)}

#: The ADC is 16 bits, but at the shortest integration it only counts this far
#: -- a datasheet quirk, not a rounding. Treating 65535 as full scale at 100 ms
#: would mean never detecting saturation there.
MAX_COUNT = 65535
MAX_COUNT_100MS = 36863

#: Lux equation constants, from the library, which took them from the Arduino
#: driver. Uncalibrated: good for relative work and for reading a room, not for
#: photometry.
LUX_DF = 408.0
LUX_COEFB = 1.64
LUX_COEFC = 0.59
LUX_COEFD = 0.86

#: Where auto-ranging aims to put the full-spectrum channel, as a fraction of
#: full scale, and the window it will leave alone. Above the ceiling there is no
#: headroom for the light to rise; below the floor the reading is mostly
#: quantisation.
#:
#: The window is deliberately narrower than it first looks like it should be.
#: Escaping a saturated reading drops to the bottom of the ladder, which
#: typically lands somewhere under a tenth of full scale -- with a slacker
#: floor that counts as "good enough" and the sensor stays parked there,
#: throwing away most of its resolution for as long as the panel is open.
TARGET_FRACTION = 0.4
FLOOR_FRACTION = 0.1
CEILING_FRACTION = 0.75

#: A settings change is believed after this many integration periods.
SETTLE_PERIODS = 2


def _ladder() -> list[tuple[int, int, float]]:
    """Every gain and integration pairing, ordered by how sensitive it is.

    Sensitivity is gain times integration time: both scale the count linearly,
    so a rung is fully described by their product, and the ladder is the range
    the part actually has. The two knobs are not interchangeable -- a longer
    integration also averages away noise and costs time -- but for the purpose
    of not saturating, only the product matters.
    """
    rungs = [
        (gain, integration, GAINS[gain] * INTEGRATION_MS[integration])
        for gain in GAINS
        for integration in INTEGRATION_MS
    ]
    return sorted(rungs, key=lambda rung: rung[2])


LADDER = _ladder()


@register("tsl2591")
class Tsl2591(Driver):
    """ams TSL2591, on the Adafruit breakout or any other board."""

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._sensor = None
        self._auto = True
        self._settled_at = 0.0
        self._ranged = ""

    def start(self) -> dict[str, Any]:
        import adafruit_tsl2591

        # The constructor checks the device ID register, so something else at
        # 0x29 fails here rather than reporting plausible darkness for ever.
        self._sensor = adafruit_tsl2591.TSL2591(self.bus, address=self.address)
        self._begin_settling()
        return {"address": self.address, **self._settings()}

    def stop(self) -> None:
        if self._sensor is not None:
            try:
                # Powered down rather than left integrating. It is a milliamp,
                # but leaving hardware running after its panel has gone is how
                # you end up debugging a part nobody is looking at.
                self._sensor.disable()
            except Exception:  # noqa: BLE001 - the part may already be unplugged
                pass
        self._sensor = None

    def command(self, name: str, args: list[Any]) -> Any:
        sensor = self._require()
        if name == "set_gain":
            # Choosing by hand turns auto off. Otherwise the next poll undoes
            # it and the control looks broken.
            self._auto = False
            sensor.gain = int(args[0])
            self._begin_settling("gain set by hand")
            return self._settings()
        if name == "set_integration":
            self._auto = False
            sensor.integration_time = int(args[0])
            self._begin_settling("integration set by hand")
            return self._settings()
        if name == "set_auto":
            self._auto = bool(args[0])
            return self._settings()
        if name == "autorange_now":
            self._autorange(force=True)
            return self._settings()
        return super().command(name, args)

    def poll(self) -> dict[str, Any]:
        sensor = self._require()
        channel_0, channel_1 = sensor.raw_luminosity
        reading = self._interpret(channel_0, channel_1)

        if self._auto:
            moved = self._autorange(channel_0=channel_0, saturated=reading["saturated"])
            if moved:
                # Report the reading that prompted the move, marked stale. The
                # alternative -- blocking for a fresh integration -- would stall
                # the whole bus for up to 1.2 seconds inside a poll.
                reading = self._interpret(channel_0, channel_1)

        reading["settling"] = self._settling()
        reading["ranged"] = self._ranged
        return reading

    # -- readings ---------------------------------------------------------

    def _interpret(self, channel_0: int, channel_1: int) -> dict[str, Any]:
        settings = self._settings()
        full_scale = settings["fullScale"]
        saturated = channel_0 >= full_scale or channel_1 >= full_scale

        # The visible channel is a difference of two measurements, so in near
        # darkness it can come out negative -- which is noise, not negative
        # light. Reported as it falls out, and separately clamped for drawing.
        visible = channel_0 - channel_1
        infrared_fraction = channel_1 / channel_0 if channel_0 > 0 else 0.0

        return {
            **settings,
            "full": channel_0,
            "infrared": channel_1,
            "visible": visible,
            "visibleClamped": max(0, visible),
            "infraredFraction": infrared_fraction,
            # None rather than a number when saturated, and deliberately so.
            # Once both channels are pinned there is no lower bound to be had:
            # the equation subtracts the infrared channel from the visible one,
            # and two equal clipped counts cancel to zero or below. Anything
            # printed here would be invented.
            "lux": (
                None
                if saturated
                else _lux(channel_0, channel_1, settings["gain"], settings["integrationMs"])
            ),
            "saturated": saturated,
            # How much of the ADC's range is in use. This is what auto-ranging
            # is steering, and the only way to see that a reading sitting at a
            # sensible-looking lux is one step from running out of room.
            "fillFraction": channel_0 / full_scale if full_scale else 0.0,
            "dark": channel_0 < full_scale * FLOOR_FRACTION,
            "atFloor": self._at_end(-1),
            "atCeiling": self._at_end(1),
            "auto": self._auto,
            "source": _source(infrared_fraction, channel_0, full_scale),
        }

    def _settings(self) -> dict[str, Any]:
        sensor = self._require()
        gain_register = sensor.gain
        integration = sensor.integration_time
        return {
            "gainRegister": gain_register,
            "gain": GAINS.get(gain_register, 1.0),
            "integrationRegister": integration,
            "integrationMs": INTEGRATION_MS.get(integration, 100.0),
            "fullScale": MAX_COUNT_100MS if integration == 0 else MAX_COUNT,
            # Carried on every reading rather than only on start(). The panel
            # builds its two dropdowns from these, and a panel that reconnects
            # to an already-running driver never sees a start().
            "gains": [{"register": r, "multiplier": m} for r, m in sorted(GAINS.items())],
            "integrations": [
                {"register": r, "milliseconds": ms} for r, ms in sorted(INTEGRATION_MS.items())
            ],
        }

    # -- auto-ranging -----------------------------------------------------

    def _autorange(self, channel_0: int = 0, saturated: bool = False, force: bool = False) -> bool:
        """Move to the rung that puts the reading in the middle of the ADC.

        From an unsaturated count the right rung is calculable rather than
        searched for: counts scale linearly with sensitivity, so the rung
        wanted is the current one times how far off target the count is. That
        is one move instead of feeling along the ladder a step at a time, which
        matters because every step costs a full integration -- up to 1.2
        seconds of the panel showing the wrong thing.

        A saturated count carries no such information. All it says is "at least
        full scale", so there is nothing to scale by. Rather than creep down a
        rung at a time -- which from the top of the ladder is eleven moves and
        the better part of half a minute of the panel saying "over range" --
        it drops straight to the least sensitive rung there is. That reading
        cannot saturate unless the light is genuinely beyond the part, and once
        it is in hand the calculation above places the right rung exactly. Two
        integrations from anywhere, instead of eleven from the top.
        """
        if self._settling() and not force:
            return False

        current = self._rung_index()
        settings = self._settings()
        full_scale = settings["fullScale"]

        if saturated:
            # All the way down, not one step. Undershooting the gain costs a
            # single coarse reading; creeping costs a rung per integration.
            target = 0
            why = "saturated"
        elif channel_0 < full_scale * FLOOR_FRACTION:
            target = self._rung_for(channel_0, full_scale, current)
            why = "too dark"
        elif channel_0 > full_scale * CEILING_FRACTION:
            target = self._rung_for(channel_0, full_scale, current)
            why = "close to saturating"
        elif force:
            target = self._rung_for(channel_0, full_scale, current)
            why = "on request"
        else:
            return False

        if target == current:
            return False

        gain, integration, _ = LADDER[target]
        sensor = self._require()
        # Gain first. Both orders leave the part briefly on a mixed pair of
        # settings, but the ADC is being discarded either way, and the gain is
        # the bigger of the two jumps.
        if gain != sensor.gain:
            sensor.gain = gain
        if integration != sensor.integration_time:
            sensor.integration_time = integration
        self._begin_settling(f"ranged {why}")
        return True

    def _rung_for(self, channel_0: int, full_scale: int, current: int) -> int:
        """The rung whose sensitivity would land this count on target."""
        if channel_0 <= 0:
            # Nothing to scale from -- pure darkness. Go as sensitive as the
            # part gets and let the next reading say something useful.
            return len(LADDER) - 1
        wanted = LADDER[current][2] * (full_scale * TARGET_FRACTION / channel_0)
        return min(range(len(LADDER)), key=lambda i: abs(LADDER[i][2] - wanted))

    def _rung_index(self) -> int:
        settings = self._settings()
        sensitivity = settings["gain"] * settings["integrationMs"]
        return min(range(len(LADDER)), key=lambda i: abs(LADDER[i][2] - sensitivity))

    def _at_end(self, direction: int) -> bool:
        """Whether the ladder has run out in a direction, which is the honest
        answer to a reading that is still too bright or too dark to range."""
        index = self._rung_index()
        return index == 0 if direction < 0 else index == len(LADDER) - 1

    # -- settling ---------------------------------------------------------

    def _begin_settling(self, why: str = "") -> None:
        integration = INTEGRATION_MS.get(self._require().integration_time, 100.0)
        self._settled_at = time.monotonic() + SETTLE_PERIODS * integration / 1000
        self._ranged = why

    def _settling(self) -> bool:
        return time.monotonic() < self._settled_at

    def _require(self):
        if self._sensor is None:
            raise RuntimeError("TSL2591 not started")
        return self._sensor


def _lux(channel_0: int, channel_1: int, gain: float, integration_ms: float) -> float:
    """The library's lux equation, without the exception.

    Same arithmetic as ``adafruit_tsl2591.TSL2591.lux``, lifted here so that an
    overflow is a flag on a reading rather than a raised RuntimeError. The
    counts-per-lux divisor folds in both knobs, which is what makes readings at
    different settings comparable at all.

    Only meaningful on unsaturated counts. The caller checks that first, since
    on clipped ones this returns zero rather than anything resembling a bound.
    """
    counts_per_lux = (integration_ms * gain) / LUX_DF
    if counts_per_lux <= 0:
        return 0.0
    lux1 = (channel_0 - LUX_COEFB * channel_1) / counts_per_lux
    lux2 = (LUX_COEFC * channel_0 - LUX_COEFD * channel_1) / counts_per_lux
    # Negative comes out of the coefficients under IR-heavy light, and means
    # the model has run out rather than that the room is darker than dark.
    return max(0.0, lux1, lux2)


def _source(infrared_fraction: float, channel_0: int, full_scale: int) -> dict[str, str]:
    """What the ratio of the two channels says about the light.

    The part measures IR-plus-visible and IR, and the ratio between them is a
    property of the illuminant rather than of its brightness: incandescent and
    sunlight carry a great deal of infrared, white LEDs and fluorescent tubes
    almost none. It is a rough classification and is offered as one -- but it
    is free, it comes from the same two numbers, and it is the difference
    between a lux figure and knowing what is lighting the room.
    """
    if channel_0 < full_scale * 0.02:
        return {"kind": "dark", "text": "Too dark to say much about the light source."}
    if infrared_fraction < 0.15:
        return {"kind": "led", "text": "Very little infrared — white LED or fluorescent."}
    if infrared_fraction < 0.35:
        return {"kind": "mixed", "text": "Some infrared — mixed or indirect daylight."}
    if infrared_fraction < 0.6:
        return {"kind": "daylight", "text": "Infrared-rich — daylight, or a halogen lamp."}
    return {"kind": "incandescent", "text": "Mostly infrared — incandescent, or a heat source."}

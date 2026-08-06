"""Real-time clocks: the RV-1805, and a base for the rest of the family.

Every I2C RTC worth supporting is the same shape -- a handful of BCD registers
holding the calendar, plus part-specific status bits -- so `RtcDriver` holds
everything that does not vary and a subclass supplies four things: where the
time registers are, how to read and write them, what the part's status bits
mean, and how finely it reports fractions of a second. DS3231, DS1307 and
PCF8563 differ from the RV-1805 in exactly those four ways.

**The panel's job is drift, not the time.** Reading a clock once tells you
nothing about it: a chip that is thirty seconds out and one that gains thirty
seconds a day look identical in a single sample. So the driver keeps its first
reading and reports the rate of change against the host clock in ppm -- along
with the resolution that measurement currently supports, because over a short
session the answer is mostly noise and saying so is more useful than a
confident wrong number.

**Time is UTC here, by decision.** These parts store a bare calendar with no
zone, so somebody has to pick. Reading and writing as UTC means the value is
unambiguous and the arithmetic against the host clock is meaningful; a panel
that showed local time would silently make the drift figure wrong twice a year.
"""

from __future__ import annotations

import calendar
import time
from typing import Any

from .base import Driver, register


def bcd_to_int(value: int) -> int:
    return (value >> 4) * 10 + (value & 0x0F)


def int_to_bcd(value: int) -> int:
    return ((value // 10) << 4) | (value % 10)


class RtcDriver(Driver):
    """Base for I2C real-time clocks."""

    #: Smallest fraction of a second the part reports. Sets how quickly a drift
    #: measurement becomes meaningful: a clock reporting whole seconds needs a
    #: hundred times longer to resolve the same ppm as one reporting hundredths.
    RESOLUTION_S = 1.0
    LABEL = "RTC"

    def __init__(self, bus, address: int) -> None:
        super().__init__(bus, address)
        self._device = None
        self._identity: str | None = None
        self._first: tuple[float, float] | None = None

    # -- to be supplied by the part ----------------------------------------

    def read_clock(self) -> tuple[time.struct_time, float]:
        """The calendar, and the fraction of a second past it."""
        raise NotImplementedError

    def write_clock(self, unix: float) -> None:
        """Set the clock to a unix timestamp.

        Takes the float rather than a struct_time so a part that can store
        fractions of a second is able to. Truncating to whole seconds here
        would leave every clock set by this panel systematically slow by up to
        a second -- which, on a part specified to two parts per million, is
        five centuries' worth of its own error budget.
        """
        raise NotImplementedError

    def flags(self) -> list[dict[str, Any]]:
        """Part-specific status, as rows the panel shows verbatim."""
        return []

    def identify(self) -> str | None:
        """Whatever the part can be asked about itself, if anything."""
        return None

    # -- shared ------------------------------------------------------------

    def start(self) -> dict[str, Any]:
        from adafruit_bus_device.i2c_device import I2CDevice

        self._device = I2CDevice(self.bus, self.address)
        self._first = None
        # Identify before anything reads the calendar. The wrong part at this
        # address still has registers, and they still decode -- into a month of
        # 68 and an exception about the calendar, which tells you nothing about
        # what actually went wrong. Asking first turns that into a sentence
        # naming the part number it found, at the moment you opened the panel.
        self._identity = self.identify()
        return {
            "address": self.address,
            "label": self.LABEL,
            "resolutionS": self.RESOLUTION_S,
            "identity": self._identity,
        }

    def stop(self) -> None:
        self._device = None
        self._first = None

    def command(self, name: str, args: list[Any]) -> Any:
        if name == "set_from_unix":
            # The caller passes the host's idea of now, taken as close to the
            # call as it can manage; the transfer itself is the remaining error.
            self.write_clock(float(args[0]))
            self._first = None  # the old drift baseline describes a different clock
            return self.poll()
        if name == "reset_drift":
            self._first = None
            return self.poll()
        return super().command(name, args)

    def poll(self) -> dict[str, Any]:
        # Bracket the read with host timestamps. The transfer is dozens of HID
        # round-trips, so the device's time corresponds to *somewhere* in that
        # window -- the midpoint is the best estimate and the half-width is the
        # honest uncertainty, which is the floor on any offset figure.
        before = time.time()
        when, fraction = self.read_clock()
        after = time.time()

        host = (before + after) / 2
        uncertainty = max((after - before) / 2, 0.0)
        device = calendar.timegm(when) + fraction
        offset = device - host

        if self._first is None:
            self._first = (host, offset)
        base_host, base_offset = self._first
        elapsed = host - base_host

        drift_ppm = None
        resolution_ppm = None
        if elapsed > 0:
            drift_ppm = ((offset - base_offset) / elapsed) * 1e6
            # What one tick of the part's own resolution would look like over
            # the elapsed time. Below this, the number is quantisation.
            resolution_ppm = (self.RESOLUTION_S / elapsed) * 1e6

        return {
            "label": self.LABEL,
            "address": self.address,
            "iso": _iso(when, fraction),
            "deviceUnix": device,
            "hostUnix": host,
            "offsetS": offset,
            "uncertaintyS": uncertainty,
            "elapsedS": elapsed,
            "driftPpm": drift_ppm,
            "resolutionPpm": resolution_ppm,
            "resolutionS": self.RESOLUTION_S,
            # Read once at start, not per poll: it cannot change, and every
            # register read is HID round-trips.
            "identity": self._identity,
            "flags": self.flags(),
        }

    # -- register helpers --------------------------------------------------

    def _read(self, register: int, length: int) -> bytes:
        buffer = bytearray(length)
        with self._require() as i2c:
            i2c.write_then_readinto(bytes([register]), buffer)
        return bytes(buffer)

    def _write(self, register: int, data: bytes) -> None:
        with self._require() as i2c:
            i2c.write(bytes([register]) + data)

    def _require(self):
        if self._device is None:
            raise RuntimeError(f"{self.LABEL} not started")
        return self._device


def _iso(when: time.struct_time, fraction: float) -> str:
    return "{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:06.3f}Z".format(
        when.tm_year, when.tm_mon, when.tm_mday, when.tm_hour, when.tm_min,
        when.tm_sec + fraction,
    )


# --------------------------------------------------------------- RV-1805


# Register map from the SparkFun RV-1805 library and the RV-1805/AB1805
# datasheet. Time is eight consecutive BCD registers starting at hundredths.
RV1805_HUNDREDTHS = 0x00
RV1805_STATUS = 0x0F
RV1805_CTRL1 = 0x10
RV1805_OSC_STATUS = 0x1D
RV1805_ID0 = 0x28

#: Register 0x28 always reads 0x18 on this part. Worth checking, because 0x69
#: is a busy address -- an MPU-6050 sits there too -- so "something answered"
#: is not the same as "the RTC is there".
RV1805_PART_NUMBER = 0x18


@register("rv1805")
class Rv1805(RtcDriver):
    """Micro Crystal RV-1805 / Abracon AB1805."""

    LABEL = "RV-1805"
    #: This part counts hundredths of a second, which is why it can resolve a
    #: drift rate a hundred times sooner than a whole-seconds clock.
    RESOLUTION_S = 0.01

    def identify(self) -> str | None:
        part = self._read(RV1805_ID0, 1)[0]
        if part != RV1805_PART_NUMBER:
            raise RuntimeError(
                f"whatever is at {self.address:#04x} reports part number "
                f"{part:#04x}, not the {RV1805_PART_NUMBER:#04x} an RV-1805 does"
            )
        return f"part number {part:#04x}"

    def read_clock(self) -> tuple[time.struct_time, float]:
        raw = self._read(RV1805_HUNDREDTHS, 8)
        hundredths, seconds, minutes, hours, date, month, year, weekday = raw
        return (
            time.struct_time(
                (
                    2000 + bcd_to_int(year),
                    bcd_to_int(month),
                    bcd_to_int(date),
                    # Bit 6 of Control1 selects 12-hour mode. The panel and this
                    # driver both work in 24-hour, and start() leaves the part
                    # in it, so the hours register is read straight.
                    bcd_to_int(hours & 0x3F),
                    bcd_to_int(minutes),
                    bcd_to_int(seconds),
                    bcd_to_int(weekday & 0x07),
                    0,
                    -1,
                )
            ),
            bcd_to_int(hundredths) / 100,
        )

    def write_clock(self, unix: float) -> None:
        # Round to the nearest hundredth, then let the carry ripple: rounding
        # 12:00:59.999 up must produce 12:01:00.00, not a sixtieth second.
        hundredths = round(unix * 100)
        when = time.gmtime(hundredths // 100)
        self._write(
            RV1805_HUNDREDTHS,
            bytes(
                [
                    int_to_bcd(hundredths % 100),
                    int_to_bcd(when.tm_sec),
                    int_to_bcd(when.tm_min),
                    int_to_bcd(when.tm_hour),
                    int_to_bcd(when.tm_mday),
                    int_to_bcd(when.tm_mon),
                    int_to_bcd(when.tm_year % 100),
                    # struct_time counts Monday as 0; the part counts Sunday.
                    int_to_bcd((when.tm_wday + 1) % 7),
                ]
            ),
        )

    def flags(self) -> list[dict[str, Any]]:
        status = self._read(RV1805_STATUS, 1)[0]
        control = self._read(RV1805_CTRL1, 1)[0]
        oscillator = self._read(RV1805_OSC_STATUS, 1)[0]

        # OMODE says which oscillator is actually running. Falling back to the
        # RC costs about three orders of magnitude of accuracy, and nothing
        # about the time it reports looks any different -- so it is the first
        # thing to check when a clock is drifting absurdly.
        on_rc = bool(oscillator & (1 << 4))
        failed = bool(oscillator & (1 << 1))

        return [
            {
                "label": "Oscillator",
                "value": "RC (internal)" if on_rc else "XT (32.768 kHz crystal)",
                "tone": "warn" if on_rc else "ok",
            },
            {
                "label": "Oscillator fault",
                "value": "yes — the time is not trustworthy" if failed else "no",
                "tone": "error" if failed else "ok",
            },
            {
                "label": "Power",
                "value": "running from backup" if status & (1 << 6) else "main supply",
                "tone": "warn" if status & (1 << 6) else "ok",
            },
            {
                "label": "Backup battery",
                "value": "low" if status & (1 << 4) else "ok",
                "tone": "warn" if status & (1 << 4) else "ok",
            },
            {
                "label": "Counting",
                "value": "stopped" if control & (1 << 7) else "running",
                "tone": "error" if control & (1 << 7) else "ok",
            },
        ]

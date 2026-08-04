"""Adafruit Mini GPS PA1010D over I2C, via the stock adafruit_gps library.

The library reads the module one byte at a time -- that is genuinely how
GPS_GtopI2C works -- so every NMEA sentence costs a few hundred HID transfers.
That is fine at 1 Hz, but it is why poll() bounds its own work instead of
letting readline() sit in its five-second timeout.
"""

from __future__ import annotations

import time
from typing import Any

from .base import Driver, register

DEFAULT_ADDRESS = 0x10

# How long a single poll may spend pulling bytes off the bus. One sentence is
# roughly 70 bytes; this leaves room for two or three without letting a silent
# module stall the UI's polling interval.
POLL_BUDGET_S = 0.6



@register("pa1010d")
class Pa1010dGps(Driver):
    """Adafruit Mini GPS PA1010D, and other GTop-based I2C receivers."""

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._gps = None
        self._sentences: list[str] = []
        self._started = 0.0
        self._first_fix: float | None = None
        self._sentence_count = 0

    def start(self) -> dict[str, Any]:
        """Attach to the module and ask it for the sentences we actually parse."""
        import adafruit_gps

        self._gps = adafruit_gps.GPS_GtopI2C(
            self.bus, address=self.address, timeout=POLL_BUDGET_S
        )
        self._sentences.clear()
        self._started = time.monotonic()
        self._first_fix = None
        self._sentence_count = 0

        # PMTK314 sets a per-sentence output rate, counted in fixes: GLL, RMC,
        # VTG, GGA, GSA, GSV, then unused. RMC and GGA every fix for position;
        # GSA every fix for the dilution figures and which satellites are in the
        # solution; GSV only every fifth, because it is several sentences of
        # satellites-in-view and each one costs hundreds of byte-at-a-time reads
        # over HID.
        self._gps.send_command(b"PMTK314,0,1,0,1,1,5,0,0,0,0,0,0,0,0,0,0,0,0,0")
        self._gps.send_command(b"PMTK220,1000")
        return {"address": self.address}

    def stop(self) -> None:
        self._gps = None
        self._sentences.clear()

    def command(self, name: str, args: list[Any]) -> Any:
        if name == "send_pmtk":
            # Raw PMTK for anything the panel does not wrap; the checksum is
            # adafruit_gps's job.
            self._require().send_command(str(args[0]).encode("ascii"))
            return True
        if name == "set_rate":
            self._require().send_command(f"PMTK220,{int(args[0])}".encode("ascii"))
            return True
        return super().command(name, args)

    def poll(self) -> dict[str, Any]:
        """Pump the parser for a bounded slice of time and report the fix."""
        gps = self._require()

        deadline = time.monotonic() + POLL_BUDGET_S
        updates = 0
        while time.monotonic() < deadline:
            if not gps.update():
                break
            updates += 1
            sentence = gps.nmea_sentence
            if sentence:
                self._sentence_count += 1
                self._sentences.append(sentence.strip())
                del self._sentences[:-12]

        has_fix = bool(gps.has_fix)
        if has_fix and self._first_fix is None:
            self._first_fix = time.monotonic() - self._started

        return {
            "hasFix": has_fix,
            "has3dFix": bool(gps.has_3d_fix),
            "fixQuality": gps.fix_quality,
            "fixMode": gps.fix_quality_3d,  # 1 none, 2 two-dimensional, 3 three
            "satellites": gps.satellites,
            "sky": self._sky_view(),
            "latitude": gps.latitude,
            "longitude": gps.longitude,
            "altitudeM": gps.altitude_m,
            "geoidHeightM": gps.height_geoid,
            "pdop": gps.pdop,
            "hdop": gps.hdop if gps.hdop is not None else gps.horizontal_dilution,
            "vdop": gps.vdop,
            "speedKnots": gps.speed_knots,
            "trackAngleDeg": gps.track_angle_deg,
            "timestampUtc": _format_timestamp(gps.timestamp_utc),
            "elapsedS": round(time.monotonic() - self._started, 1),
            "timeToFirstFixS": (
                round(self._first_fix, 1) if self._first_fix is not None else None
            ),
            "sentenceCount": self._sentence_count,
            "sentences": list(self._sentences),
            "updates": updates,
        }

    def _require(self):
        if self._gps is None:
            raise RuntimeError("GPS not started")
        return self._gps

    def _sky_view(self) -> list[dict[str, Any]]:
        """Every satellite the receiver can hear, strongest first.

        This is the part worth watching before a fix: satellites appear and
        their signal-to-noise climbs while the position is still unknown, which
        is the difference between "it is working on it" and "it is not seeing
        the sky".

        GSV reports what is *in view*; GSA reports which of those the solution
        actually used. They are different sets, and the gap between them is what
        says whether a weak sky is the reason there is no fix yet.
        """
        gps = self._require()
        used = set(gps.sat_prns or ())
        sky = [
            {
                "prn": prn,
                "elevation": info[1],
                "azimuth": info[2],
                "snr": info[3],
                "used": prn in used,
            }
            for prn, info in (gps.sats or {}).items()
        ]
        sky.sort(key=lambda sat: (-(sat["snr"] or 0), sat["prn"]))
        return sky


def _format_timestamp(stamp) -> str | None:
    if stamp is None:
        return None
    return "{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z".format(
        stamp.tm_year, stamp.tm_mon, stamp.tm_mday, stamp.tm_hour, stamp.tm_min, stamp.tm_sec
    )

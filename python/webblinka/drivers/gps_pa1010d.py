"""Adafruit Mini GPS PA1010D over I2C, via the stock adafruit_gps library.

The library reads the module one byte at a time -- that is genuinely how
GPS_GtopI2C works -- so every NMEA sentence costs a few hundred HID transfers.
That is fine at 1 Hz, but it is why poll() bounds its own work instead of
letting readline() sit in its five-second timeout.
"""

from __future__ import annotations

import time
from typing import Any

from ..rpc import handler
from ..session import i2c

DEFAULT_ADDRESS = 0x10

# How long a single poll may spend pulling bytes off the bus. One sentence is
# roughly 70 bytes; this leaves room for two or three without letting a silent
# module stall the UI's polling interval.
POLL_BUDGET_S = 0.6

_gps = None
_sentences: list[str] = []
_started = 0.0
_first_fix: float | None = None
_sentence_count = 0


@handler
def gps_start(address: int = DEFAULT_ADDRESS) -> dict[str, Any]:
    """Attach to the module and ask it for the sentences we actually parse."""
    global _gps, _started, _first_fix, _sentence_count
    import adafruit_gps

    _gps = adafruit_gps.GPS_GtopI2C(i2c(), address=address, timeout=POLL_BUDGET_S)
    _sentences.clear()
    _started = time.monotonic()
    _first_fix = None
    _sentence_count = 0

    # PMTK314 sets a per-sentence output rate, counted in fixes: GLL, RMC, VTG,
    # GGA, GSA, GSV, then unused. RMC and GGA every fix for position; GSA every
    # fix for the dilution figures and which satellites are in the solution; GSV
    # only every fifth, because it is several sentences of satellites-in-view
    # and each one costs hundreds of byte-at-a-time reads over HID.
    _gps.send_command(b"PMTK314,0,1,0,1,1,5,0,0,0,0,0,0,0,0,0,0,0,0,0")
    _gps.send_command(b"PMTK220,1000")
    return {"address": address}


@handler
def gps_stop() -> None:
    global _gps
    _gps = None
    _sentences.clear()


@handler
def gps_poll() -> dict[str, Any]:
    """Pump the parser for a bounded slice of time and report the fix."""
    global _first_fix, _sentence_count

    if _gps is None:
        raise RuntimeError("GPS not started")

    deadline = time.monotonic() + POLL_BUDGET_S
    updates = 0
    while time.monotonic() < deadline:
        if not _gps.update():
            break
        updates += 1
        sentence = _gps.nmea_sentence
        if sentence:
            _sentence_count += 1
            _sentences.append(sentence.strip())
            del _sentences[:-12]

    has_fix = bool(_gps.has_fix)
    if has_fix and _first_fix is None:
        _first_fix = time.monotonic() - _started

    return {
        "hasFix": has_fix,
        "has3dFix": bool(_gps.has_3d_fix),
        "fixQuality": _gps.fix_quality,
        "fixMode": _gps.fix_quality_3d,  # 1 none, 2 two-dimensional, 3 three
        "satellites": _gps.satellites,
        "sky": _sky_view(),
        "latitude": _gps.latitude,
        "longitude": _gps.longitude,
        "altitudeM": _gps.altitude_m,
        "geoidHeightM": _gps.height_geoid,
        "pdop": _gps.pdop,
        "hdop": _gps.hdop if _gps.hdop is not None else _gps.horizontal_dilution,
        "vdop": _gps.vdop,
        "speedKnots": _gps.speed_knots,
        "trackAngleDeg": _gps.track_angle_deg,
        "timestampUtc": _format_timestamp(_gps.timestamp_utc),
        "elapsedS": round(time.monotonic() - _started, 1),
        "timeToFirstFixS": round(_first_fix, 1) if _first_fix is not None else None,
        "sentenceCount": _sentence_count,
        "sentences": list(_sentences),
        "updates": updates,
    }


def _sky_view() -> list[dict[str, Any]]:
    """Every satellite the receiver can hear, strongest first.

    This is the part worth watching before a fix: satellites appear and their
    signal-to-noise climbs while the position is still unknown, which is the
    difference between "it is working on it" and "it is not seeing the sky".

    GSV reports what is *in view*; GSA reports which of those the solution
    actually used. They are different sets, and the gap between them is what
    says whether a weak sky is the reason there is no fix yet.
    """
    used = set(_gps.sat_prns or ())
    sky = [
        {
            "prn": prn,
            "elevation": info[1],
            "azimuth": info[2],
            "snr": info[3],
            "used": prn in used,
        }
        for prn, info in (_gps.sats or {}).items()
    ]
    sky.sort(key=lambda sat: (-(sat["snr"] or 0), sat["prn"]))
    return sky


def _format_timestamp(stamp) -> str | None:
    if stamp is None:
        return None
    return "{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z".format(
        stamp.tm_year, stamp.tm_mon, stamp.tm_mday, stamp.tm_hour, stamp.tm_min, stamp.tm_sec
    )

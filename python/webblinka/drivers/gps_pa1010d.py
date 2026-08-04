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


@handler
def gps_start(address: int = DEFAULT_ADDRESS) -> dict[str, Any]:
    """Attach to the module and ask it for the sentences we actually parse."""
    global _gps
    import adafruit_gps

    _gps = adafruit_gps.GPS_GtopI2C(i2c(), address=address, timeout=POLL_BUDGET_S)
    _sentences.clear()

    # RMC + GGA only, once per second: everything the panel shows, and no more
    # bytes to drag over the bus than necessary.
    _gps.send_command(b"PMTK314,0,1,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0")
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
            _sentences.append(sentence.strip())
            del _sentences[:-12]

    return {
        "hasFix": bool(_gps.has_fix),
        "has3dFix": bool(_gps.has_3d_fix),
        "fixQuality": _gps.fix_quality,
        "satellites": _gps.satellites,
        "latitude": _gps.latitude,
        "longitude": _gps.longitude,
        "altitudeM": _gps.altitude_m,
        "hdop": _gps.hdop if _gps.hdop is not None else _gps.horizontal_dilution,
        "speedKnots": _gps.speed_knots,
        "trackAngleDeg": _gps.track_angle_deg,
        "timestampUtc": _format_timestamp(_gps.timestamp_utc),
        "sentences": list(_sentences),
        "updates": updates,
    }


def _format_timestamp(stamp) -> str | None:
    if stamp is None:
        return None
    return "{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z".format(
        stamp.tm_year, stamp.tm_mon, stamp.tm_mday, stamp.tm_hour, stamp.tm_min, stamp.tm_sec
    )

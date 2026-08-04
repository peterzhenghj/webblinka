"""The board session: brings Blinka up against the connected MCP2221.

Everything here is stock CircuitPython API -- `board`, `busio`, `digitalio` --
which is the whole point. If a snippet works on a Raspberry Pi with Blinka, it
should work here unchanged.
"""

from __future__ import annotations

from typing import Any

from .rpc import handler

_i2c = None
_mcp = None


def i2c():
    """The shared busio.I2C, or raise if the page has not connected yet."""
    if _i2c is None:
        raise RuntimeError("not connected -- call connect() first")
    return _i2c


@handler
def connect() -> dict[str, Any]:
    """Import Blinka against the open HID device and take the I2C bus.

    Importing `board` is what constructs Blinka's MCP2221 singleton, so this is
    the first moment any HID traffic happens.
    """
    global _i2c, _mcp

    import board
    import busio
    from adafruit_blinka.agnostic import board_id, chip_id
    from adafruit_blinka.microcontroller.mcp2221.mcp2221 import mcp2221

    _mcp = mcp2221
    # A page reload can leave the I2C engine mid-transfer from the previous
    # session. Blinka normally clears that with a chip reset, but a reset
    # re-enumerates the USB device and would invalidate the page's HIDDevice, so
    # cancel the transfer instead -- same effect, device stays put.
    _mcp._i2c_cancel()  # noqa: SLF001 - no public spelling for this

    _i2c = busio.I2C(board.SCL, board.SDA)

    return {
        "chip": chip_id,
        "board": board_id,
        "pins": [name for name in ("G0", "G1", "G2", "G3") if hasattr(board, name)],
    }


@handler
def i2c_scan() -> list[int]:
    """Addresses that ACK'd, as busio's scan() reports them (7-bit)."""
    bus = i2c()
    while not bus.try_lock():
        pass
    try:
        return list(bus.scan())
    finally:
        bus.unlock()


@handler
def set_i2c_frequency(hz: int) -> int:
    """Reconfigure the bus clock. The MCP2221 supports roughly 47kHz-400kHz.

    Replaces the shared bus object, so anything already holding a reference to
    the old one (a running driver) should be restarted afterwards.
    """
    global _i2c
    import board
    import busio

    _i2c = busio.I2C(board.SCL, board.SDA, frequency=hz)
    return hz


# ---------------------------------------------------------------------- GPIO

# The MCP2221's four general-purpose pins, and what each one can actually be.
# ADC lives on GP1-GP3 and the (5-bit) DAC on GP2-GP3; Blinka raises if you ask
# for anything else, so the UI is told up front rather than by trial and error.
PIN_CAPABILITIES = {
    "G0": ["input", "output"],
    "G1": ["input", "output", "analog_in"],
    "G2": ["input", "output", "analog_in", "analog_out"],
    "G3": ["input", "output", "analog_in", "analog_out"],
}

_pins: dict[str, dict[str, Any]] = {}


@handler
def gpio_capabilities() -> dict[str, list[str]]:
    return PIN_CAPABILITIES


@handler
def gpio_configure(name: str, mode: str) -> dict[str, Any]:
    """Claim a pin in one of its supported modes, releasing any previous claim."""
    if mode not in PIN_CAPABILITIES.get(name, []):
        raise ValueError(f"{name} cannot be {mode}")

    import analogio
    import board
    import digitalio

    previous = _pins.pop(name, None)
    if previous is not None:
        previous["object"].deinit()

    pin = getattr(board, name)
    if mode in ("input", "output"):
        obj = digitalio.DigitalInOut(pin)
        obj.direction = (
            digitalio.Direction.INPUT if mode == "input" else digitalio.Direction.OUTPUT
        )
    elif mode == "analog_in":
        obj = analogio.AnalogIn(pin)
    else:
        obj = analogio.AnalogOut(pin)

    _pins[name] = {"object": obj, "mode": mode, "written": 0}
    return gpio_state(name)


@handler
def gpio_release(name: str) -> None:
    entry = _pins.pop(name, None)
    if entry is not None:
        entry["object"].deinit()


@handler
def gpio_write(name: str, value: int) -> dict[str, Any]:
    entry = _require_pin(name)
    if entry["mode"] == "output":
        entry["object"].value = bool(value)
    elif entry["mode"] == "analog_out":
        # CircuitPython's AnalogOut takes 16 bits; Blinka scales down to the
        # MCP2221's 5-bit DAC on the way out.
        entry["object"].value = max(0, min(65535, int(value)))
    else:
        raise ValueError(f"{name} is configured as {entry['mode']} and cannot be written")
    entry["written"] = int(value)
    return gpio_state(name)


@handler
def gpio_state(name: str) -> dict[str, Any]:
    entry = _require_pin(name)
    mode = entry["mode"]
    if mode in ("input", "output"):
        value = int(entry["object"].value)
    elif mode == "analog_in":
        value = int(entry["object"].value)
    else:
        value = int(entry["written"])  # the DAC is write-only
    return {"name": name, "mode": mode, "value": value}


@handler
def gpio_read_all() -> list[dict[str, Any]]:
    """One HID round-trip per claimed pin, so the UI can poll cheaply."""
    return [gpio_state(name) for name in list(_pins)]


def _require_pin(name: str) -> dict[str, Any]:
    entry = _pins.get(name)
    if entry is None:
        raise RuntimeError(f"{name} is not configured")
    return entry


# ------------------------------------------------------------------- runtime


@handler
def runtime_info() -> dict[str, Any]:
    import sys

    import board

    return {
        "python": sys.version.split()[0],
        "blinka": board.__version__,
        "connected": _i2c is not None,
    }

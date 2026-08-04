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

    from . import mcp2221_chip

    _mcp = mcp2221
    # A page reload can leave the I2C engine mid-transfer from the previous
    # session. Blinka normally clears that with a chip reset, but a reset
    # re-enumerates the USB device and would invalidate the page's HIDDevice, so
    # cancel the transfer instead -- same effect, device stays put. Poll until
    # the engine is actually idle rather than assuming one cancel took.
    bus_state = mcp2221_chip.force_idle()

    # The clock divider is only accepted while the engine is idle, so this has
    # to come after the cancel.
    _i2c = busio.I2C(board.SCL, board.SDA)

    return {
        "chip": chip_id,
        "board": board_id,
        "pins": [name for name in ("G0", "G1", "G2", "G3") if hasattr(board, name)],
        "bus": bus_state,
    }


@handler
def rebuild_bus() -> dict[str, Any]:
    """Take the bus again after the chip has been reset out from under us."""
    global _i2c
    import board
    import busio

    from . import mcp2221_chip

    bus_state = mcp2221_chip.resync()
    _pins.clear()  # a reset returned every pin to its flash default
    _i2c = busio.I2C(board.SCL, board.SDA)
    return bus_state


# The I2C spec reserves 0x00-0x07 and 0x78-0x7f. i2cdetect skips them and so do
# we: 0x00 in particular is the general call address, and Blinka's own scan
# writes a 0x00 byte to it, which is the general-call software-reset command.
FIRST_ADDRESS = 0x08
LAST_ADDRESS = 0x77


@handler
def i2c_scan() -> list[int]:
    """Addresses that ACK'd (7-bit).

    Deliberately not busio's scan(). Blinka probes with a one-byte write of
    0x00, which is a real write -- on a device with an auto-incrementing pointer
    that lands in register 0 -- and it aborts the entire sweep if any single
    address leaves the MCP2221's I2C engine unhappy. A zero-length write is the
    standard probe and touches nothing, and a wedged engine is a reason to
    recover and carry on to the next address, not to abandon the scan.
    """
    from . import mcp2221_chip

    bus = i2c()
    chip = mcp2221_chip.chip()
    found = []

    while not bus.try_lock():
        pass
    try:
        for address in range(FIRST_ADDRESS, LAST_ADDRESS + 1):
            try:
                chip.i2c_writeto(address, b"")
            except OSError:
                continue  # NACK: nothing at this address
            except RuntimeError:
                # The engine reported an unrecoverable state for this probe.
                # Clear it and keep going; one sulky address is not the scan.
                mcp2221_chip.force_idle()
                continue
            found.append(address)
    finally:
        bus.unlock()
    return found


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

# Each MCP2221 pin has a three-bit *designation* in SRAM selecting one of
# several hardwired functions, only some of which CircuitPython has a name for.
# `input`, `output`, `analog_in` and `analog_out` go through digitalio/analogio,
# because that is the whole point of running Blinka. The rest are chip
# functions with no CircuitPython equivalent, so they are set by writing the
# designation directly -- still through Blinka's own gp_set_mode.
#
# Designation codes come from the datasheet's GP settings tables; Blinka spells
# the same values GP_GPIO / GP_DEDICATED / GP_ALT0 / GP_ALT1 / GP_ALT2.
PIN_MODES: dict[str, dict[str, dict[str, Any]]] = {
    "G0": {
        "input": {"code": 0b000, "label": "Digital in", "kind": "digital"},
        "output": {"code": 0b000, "label": "Digital out", "kind": "digital"},
        "sspnd": {"code": 0b001, "label": "SSPND (USB suspend)", "kind": "dedicated"},
        "led_uart_rx": {"code": 0b010, "label": "LED — UART Rx", "kind": "dedicated"},
    },
    "G1": {
        "input": {"code": 0b000, "label": "Digital in", "kind": "digital"},
        "output": {"code": 0b000, "label": "Digital out", "kind": "digital"},
        "clock_out": {"code": 0b001, "label": "Clock output", "kind": "clock"},
        "analog_in": {"code": 0b010, "label": "ADC 1", "kind": "adc"},
        "led_uart_tx": {"code": 0b011, "label": "LED — UART Tx", "kind": "dedicated"},
        "interrupt": {"code": 0b100, "label": "Interrupt on change", "kind": "interrupt"},
    },
    "G2": {
        "input": {"code": 0b000, "label": "Digital in", "kind": "digital"},
        "output": {"code": 0b000, "label": "Digital out", "kind": "digital"},
        "usb_config": {"code": 0b001, "label": "USBCFG (USB configured)", "kind": "dedicated"},
        "analog_in": {"code": 0b010, "label": "ADC 2", "kind": "adc"},
        "analog_out": {"code": 0b011, "label": "DAC 1", "kind": "dac"},
    },
    "G3": {
        "input": {"code": 0b000, "label": "Digital in", "kind": "digital"},
        "output": {"code": 0b000, "label": "Digital out", "kind": "digital"},
        "led_i2c": {"code": 0b001, "label": "LED — I²C", "kind": "dedicated"},
        "analog_in": {"code": 0b010, "label": "ADC 3", "kind": "adc"},
        "analog_out": {"code": 0b011, "label": "DAC 2", "kind": "dac"},
    },
}

# Which ADC channel each pin reports on. GP1 is channel 0.
ADC_CHANNEL = {"G1": 0, "G2": 1, "G3": 2}

_pins: dict[str, dict[str, Any]] = {}


@handler
def gpio_modes() -> dict[str, list[dict[str, Any]]]:
    """The selectable designation for every pin, in menu order."""
    return {
        name: [{"mode": mode, **spec} for mode, spec in modes.items()]
        for name, modes in PIN_MODES.items()
    }


def _spec(name: str, mode: str) -> dict[str, Any]:
    spec = PIN_MODES.get(name, {}).get(mode)
    if spec is None:
        raise ValueError(f"{name} cannot be {mode}")
    return spec


@handler
def gpio_configure(name: str, mode: str) -> dict[str, Any]:
    """Put a pin into one of its designations, releasing any previous claim."""
    spec = _spec(name, mode)

    import analogio
    import board
    import digitalio

    previous = _pins.pop(name, None)
    if previous is not None and previous["object"] is not None:
        previous["object"].deinit()

    pin = getattr(board, name)
    if mode in ("input", "output"):
        obj = digitalio.DigitalInOut(pin)
        obj.direction = (
            digitalio.Direction.INPUT if mode == "input" else digitalio.Direction.OUTPUT
        )
    elif mode == "analog_in":
        obj = analogio.AnalogIn(pin)
    elif mode == "analog_out":
        obj = analogio.AnalogOut(pin)
    else:
        # A dedicated chip function. There is no CircuitPython object to hold,
        # just a designation to write.
        from . import mcp2221_chip

        mcp2221_chip.chip().gp_set_mode(int(name[1]), spec["code"])
        obj = None

    _pins[name] = {"object": obj, "mode": mode, "kind": spec["kind"], "written": 0}
    return gpio_state(name)


@handler
def gpio_release(name: str) -> None:
    entry = _pins.pop(name, None)
    if entry is not None and entry["object"] is not None:
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
    mode, kind = entry["mode"], entry["kind"]
    if kind == "digital":
        value = int(entry["object"].value)
    elif kind == "adc":
        value = int(entry["object"].value)
    elif kind == "dac":
        value = int(entry["written"])  # the DAC is write-only
    else:
        value = None  # a dedicated function the chip drives on its own
    return {"name": name, "mode": mode, "kind": kind, "value": value}


@handler
def gpio_read_all() -> list[dict[str, Any]]:
    """One HID round-trip per readable pin, so the UI can poll cheaply."""
    return [
        gpio_state(name)
        for name, entry in list(_pins.items())
        if entry["kind"] in ("digital", "adc", "dac")
    ]


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

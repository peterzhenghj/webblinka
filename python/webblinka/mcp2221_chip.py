"""Low-level MCP2221 access for the things CircuitPython has no words for.

Blinka speaks `board`/`busio`/`digitalio` — a deliberately portable vocabulary
that stops at the edge of what every CircuitPython board can do. The MCP2221 has
plenty beyond that edge: UART activity LEDs, a clock output, USB suspend and
configured indicators, interrupt-on-change, ADC/DAC reference selection, and the
USB descriptor strings in its flash.

None of that requires forking Blinka. Its MCP2221 singleton already owns the HID
transport, so this module borrows it and speaks the chip's own report protocol
directly. Byte layouts follow the MCP2221 datasheet's command tables.

**Flash is read-only here on purpose.** Writing chip settings can change the
VID/PID or lock the device behind a password, which would make it unreachable
from this page — and from WebHID generally, since the vendor filter would no
longer match. Reading descriptors is safe; rewriting them is not the kind of
thing a web page should offer.
"""

from __future__ import annotations

from typing import Any

from .rpc import handler

REPORT_SIZE = 64

# Commands.
CMD_STATUS = 0x10
CMD_SET_GPIO = 0x50
CMD_GET_GPIO = 0x51
CMD_SET_SRAM = 0x60
CMD_GET_SRAM = 0x61
CMD_READ_FLASH = 0xB0

# Read Flash Data sub-commands.
FLASH_CHIP_SETTINGS = 0x00
FLASH_GP_SETTINGS = 0x01
FLASH_USB_MANUFACTURER = 0x02
FLASH_USB_PRODUCT = 0x03
FLASH_USB_SERIAL = 0x04
FLASH_FACTORY_SERIAL = 0x05

# Every "alter this field" flag in the Set SRAM command is the high bit.
ALTER = 0x80

# GP designation selecting the ADC, the same on every pin that has one.
ADC_DESIGNATION = 0b010

# USB string descriptors carry a 0x03 (STRING) descriptor type byte.
USB_STRING_DESCRIPTOR_TYPE = 0x03

VOLTAGE_NAMES = {0b00: "off", 0b01: "1.024V", 0b10: "2.048V", 0b11: "4.096V"}
VOLTAGE_BITS = {name: bits for bits, name in VOLTAGE_NAMES.items()}

DUTY_CYCLE_NAMES = {0b00: "0%", 0b01: "25%", 0b10: "50%", 0b11: "75%"}
DUTY_CYCLE_BITS = {name: bits for bits, name in DUTY_CYCLE_NAMES.items()}

# The clock divider field counts down from 24 MHz.
DIVIDER_NAMES = {
    0b001: "24 MHz",
    0b010: "12 MHz",
    0b011: "6 MHz",
    0b100: "3 MHz",
    0b101: "1.5 MHz",
    0b110: "750 kHz",
    0b111: "375 kHz",
}
DIVIDER_BITS = {name: bits for bits, name in DIVIDER_NAMES.items()}

SECURITY_NAMES = {0b00: "unsecured", 0b01: "password protected", 0b10: "permanently locked"}

# I2C engine states as reported in status byte 8. Only the ones worth naming.
I2C_STATE_NAMES = {
    0x00: "idle",
    0x10: "start",
    0x11: "start ack",
    0x12: "start timeout",
    0x15: "repeated start",
    0x16: "repeated start ack",
    0x17: "repeated start timeout",
    0x20: "address",
    0x21: "address wait send",
    0x22: "address ack",
    0x23: "address timeout",
    0x24: "address nack, stop end",
    0x25: "address nack, stop",
    0x40: "write data",
    0x41: "write data wait send",
    0x42: "write data ack",
    0x43: "write data wait",
    0x44: "write data timeout",
    0x45: "write data end, no stop",
    0x50: "read data",
    0x52: "read data timeout",
    0x53: "read data ack",
    0x54: "read data wait",
    0x55: "read data complete",
    0x60: "stop",
    0x61: "stop wait",
    0x62: "stop timeout",
    0x7F: "error",
}


def chip():
    """Blinka's MCP2221 singleton, which owns the open HID device."""
    from adafruit_blinka.microcontroller.mcp2221.mcp2221 import mcp2221

    return mcp2221


def xfer(report: bytes, response: bool = True) -> list[int]:
    """One 64-byte command/response exchange on Blinka's HID transport."""
    result = chip()._hid_xfer(bytes(report), response=response)  # noqa: SLF001
    return list(result) if result is not None else []


# ------------------------------------------------------------------- status


@handler
def chip_status() -> dict[str, Any]:
    """Everything the Status/Set Parameters command reports (datasheet 3.1.1)."""
    r = xfer(bytes([CMD_STATUS]))
    if r[1] != 0x00:
        raise RuntimeError(f"status command failed with 0x{r[1]:02x}")

    i2c_state = r[8]
    # Byte 20 bit 6 is the address-NACK flag; Blinka reads the same bit.
    acked = not bool(r[20] & 0x40)

    return {
        "i2c": {
            "state": i2c_state,
            "stateName": I2C_STATE_NAMES.get(i2c_state, f"unknown (0x{i2c_state:02x})"),
            "cancellation": {0x00: "none", 0x10: "marked", 0x11: "idle"}.get(r[2], "?"),
            "address": r[16] | (r[17] << 8),
            "requestedTransferLength": r[9] | (r[10] << 8),
            "transferredBytes": r[11] | (r[12] << 8),
            "dataBufferCounter": r[13],
            "speedDivider": r[14],
            "timeoutMs": r[15],
            "scl": r[22],
            "sda": r[23],
            "acked": acked,
            "pendingValue": r[25],
        },
        "adc": {
            # 10-bit conversions, little-endian, one per ADC-capable pin.
            "ch0": r[50] | (r[51] << 8),
            "ch1": r[52] | (r[53] << 8),
            "ch2": r[54] | (r[55] << 8),
        },
        "interruptEdgeDetected": r[24] == 1,
        "revision": {
            "hardware": f"{chr(r[46])}.{chr(r[47])}",
            "firmware": f"{chr(r[48])}.{chr(r[49])}",
        },
    }


@handler
def common_status() -> dict[str, Any]:
    """Status plus the pin designations, in one call.

    The Common tab wants both once a second: the status report for the live
    figures, and the GP designations to know which of the three ADC channels
    are connected to anything. Two commands in one call rather than two calls
    keeps them consistent with each other and halves the trips through the
    serialised queue.
    """
    status = chip_status()
    sram = _sram()
    # ADC channels 0-2 are GP1-GP3, and only report anything real when the pin
    # is designated as an ADC -- otherwise the converter is not connected to it.
    status["adcChannels"] = [
        {"channel": pin - 1, "pin": f"G{pin}", "enabled": (sram[22 + pin] & 0b111) == ADC_DESIGNATION}
        for pin in (1, 2, 3)
    ]
    return status


@handler
def force_idle(attempts: int = 8) -> dict[str, Any]:
    """Drag the I2C engine back to idle, and report where it ended up.

    A cancel is a *request*: the chip answers 0x10 in byte 2 to say it has
    marked the transfer for cancellation, and the engine only reaches idle a
    few hundred microseconds later. Blinka's single 1 ms sleep is usually
    enough and occasionally is not, which is the whole story behind its
    "Unrecoverable I2C state failure" -- the next command arrives while the
    engine is still winding down, gets rejected as busy, and the rejection is
    read as a fatal bus state. Polling until it is genuinely idle is cheap.

    The SCL/SDA levels come back too, because they are what distinguishes the
    two reasons this can fail to reach idle. Both high means the bus is free
    and the chip itself is stuck -- a reset clears that. Either one low means a
    device is holding the line and no amount of cancelling will help.

    Two rules, both learned the hard way, both about not provoking the chip:

    Look before touching. Cancelling asks the engine to release the bus, which
    means driving a STOP. Ask that of an engine that is already idle and has no
    transaction to terminate and the STOP has nothing to complete against -- it
    times out, and the engine that was perfectly fine now reports "stop timeout".
    So read the status first and only cancel if there is something to cancel.

    Then cancel *once*. Repeating it on every poll re-triggers the wind-down the
    poll is waiting on, pinning the engine in the state it is trying to leave.
    """
    import time

    r = xfer(bytes([CMD_STATUS]))  # look first
    if r[1] != 0x00:
        raise RuntimeError(f"status rejected with 0x{r[1]:02x}")

    if r[8] != 0x00:
        r = xfer(bytes([CMD_STATUS, 0x00, 0x10]))  # status, and cancel the transfer
        if r[1] != 0x00:
            raise RuntimeError(f"cancel rejected with 0x{r[1]:02x}")

        for _ in range(attempts):
            if r[8] == 0x00:
                break
            time.sleep(0.002)
            r = xfer(bytes([CMD_STATUS]))  # plain status: ask, do not re-cancel
            if r[1] != 0x00:
                raise RuntimeError(f"status rejected with 0x{r[1]:02x}")

    state = r[8]
    return {
        "state": I2C_STATE_NAMES.get(state, f"unknown (0x{state:02x})"),
        "idle": state == 0x00,
        "scl": r[22],
        "sda": r[23],
    }


@handler
def reset_chip() -> None:
    """Ask the chip to reset itself.

    This is the only thing that clears an engine wedged somewhere a cancel
    cannot reach. Blinka does it on every startup; webblinka does not, because
    the chip drops off USB and re-enumerates, which invalidates the HIDDevice
    the page is holding. The page has to notice the reconnect and re-acquire the
    device -- see WebHidTransport.reacquire -- so this is offered as an explicit
    recovery rather than done silently at connect.

    No reply comes back: the device is already gone by then.
    """
    xfer(bytes([0x70, 0xAB, 0xCD, 0xEF]), response=False)


@handler
def resync() -> dict[str, Any]:
    """Re-read the chip's real state into Blinka after a reset.

    Blinka's MCP2221 object caches the four GP configuration bytes so it can
    write one pin without disturbing the others. A reset returns the chip to its
    flash defaults, which leaves that cache describing a chip that no longer
    exists -- so the next pin change would write back stale settings for the
    other three.
    """
    sram = _sram()
    device = chip()
    device._gp_config = [sram[22 + pin] for pin in range(4)]  # noqa: SLF001
    return force_idle()


@handler
def clear_interrupt() -> None:
    """Clear the interrupt-on-change latch (Set SRAM, interrupt byte bit 0)."""
    _set_sram(b6=ALTER | 0b1)


# --------------------------------------------------------------- SRAM state


def _sram() -> list[int]:
    r = xfer(bytes([CMD_GET_SRAM]))
    if r[1] != 0x00:
        raise RuntimeError(f"get SRAM failed with 0x{r[1]:02x}")
    return r


def _decode_chip_byte(value: int) -> dict[str, Any]:
    return {
        "cdcSerialEnumeration": bool(value & (1 << 7)),
        "uartRxLed": bool(value & (1 << 6)),
        "uartTxLed": bool(value & (1 << 5)),
        "i2cLed": bool(value & (1 << 4)),
        "sspnd": bool(value & (1 << 3)),
        "usbcfg": bool(value & (1 << 2)),
        "security": SECURITY_NAMES.get(value & 0b11, "?"),
    }


def _decode_gp_shared(sram: list[int]) -> dict[str, Any]:
    clock_byte = sram[5]
    dac_byte = sram[6]
    adc_byte = sram[7]

    negative = bool(adc_byte & (1 << 6))
    positive = bool(adc_byte & (1 << 5))
    edge = (
        "both" if negative and positive else
        "negative" if negative else
        "positive" if positive else
        "off"
    )

    return {
        "clock": {
            "dutyCycle": DUTY_CYCLE_NAMES.get((clock_byte >> 3) & 0b11, "?"),
            "divider": DIVIDER_NAMES.get(clock_byte & 0b111, "reserved"),
        },
        # In the Get response the DAC byte packs option at bit 5 and voltage at
        # bits 6-7; the Set command uses a different packing. They are not
        # symmetric, which is a datasheet quirk rather than a bug here.
        "dac": {
            "referenceVoltage": VOLTAGE_NAMES.get((dac_byte >> 6) & 0b11, "?"),
            "referenceOption": "Vrm" if (dac_byte >> 5) & 0b1 else "Vdd",
            "value": dac_byte & 0b11111,
        },
        "adc": {
            "referenceVoltage": VOLTAGE_NAMES.get((adc_byte >> 3) & 0b11, "?"),
            "referenceOption": "Vrm" if (adc_byte >> 2) & 0b1 else "Vdd",
        },
        "interrupt": {"edge": edge},
    }


@handler
def sram_settings() -> dict[str, Any]:
    """Live chip configuration: designations, references, clock, USB identity."""
    sram = _sram()
    return {
        "chip": _decode_chip_byte(sram[4]),
        "gp": _decode_gp_shared(sram),
        "usb": {
            "vendorId": sram[8] | (sram[9] << 8),
            "productId": sram[10] | (sram[11] << 8),
            "selfPowered": bool(sram[12] & 0x40),
            "remoteWake": bool(sram[12] & 0x20),
            "mARequested": sram[13] * 2,
        },
        "pins": [
            {
                "designation": sram[22 + pin] & 0b111,
                "direction": "in" if (sram[22 + pin] >> 3) & 0b1 else "out",
                "value": (sram[22 + pin] >> 4) & 0b1,
            }
            for pin in range(4)
        ],
    }


def _set_sram(**fields: int) -> None:
    """Send a Set SRAM report altering only the named bytes.

    Every field is skipped unless its alter flag is set, so a report of zeros
    changes nothing — which is what makes it safe to touch one setting at a time.
    """
    report = bytearray(REPORT_SIZE)
    report[0] = CMD_SET_SRAM
    for index, value in fields.items():
        report[int(index.removeprefix("b"))] = value
    result = xfer(report)
    if result[1] != 0x00:
        raise RuntimeError(f"set SRAM failed with 0x{result[1]:02x}")


@handler
def set_clock_output(duty_cycle: str, divider: str) -> dict[str, Any]:
    if duty_cycle not in DUTY_CYCLE_BITS:
        raise ValueError(f"unknown duty cycle {duty_cycle!r}")
    if divider not in DIVIDER_BITS:
        raise ValueError(f"unknown clock rate {divider!r}")
    _set_sram(b2=ALTER | (DUTY_CYCLE_BITS[duty_cycle] << 3) | DIVIDER_BITS[divider])
    return sram_settings()["gp"]["clock"]


@handler
def set_dac_reference(voltage: str, option: str) -> dict[str, Any]:
    _set_sram(b3=ALTER | (_voltage_bits(voltage) << 1) | (1 if option == "Vrm" else 0))
    return sram_settings()["gp"]["dac"]


@handler
def set_dac_value(value: int) -> dict[str, Any]:
    """Set the 5-bit DAC directly, bypassing analogio's 16-bit scaling."""
    _set_sram(b4=ALTER | (int(value) & 0b11111))
    return sram_settings()["gp"]["dac"]


@handler
def set_adc_reference(voltage: str, option: str) -> dict[str, Any]:
    _set_sram(b5=ALTER | (_voltage_bits(voltage) << 1) | (1 if option == "Vrm" else 0))
    return sram_settings()["gp"]["adc"]


@handler
def set_interrupt_edge(edge: str) -> dict[str, Any]:
    positive = edge in ("positive", "both")
    negative = edge in ("negative", "both")
    if edge == "off":
        edge_bits = 0b1010
    else:
        # Bits 3 and 1 enable the change, bits 2 and 0 select the edges.
        edge_bits = 0b1010 | (int(positive) << 2) | int(negative)
    _set_sram(b6=ALTER | (edge_bits << 1))
    return sram_settings()["gp"]["interrupt"]


def _voltage_bits(voltage: str) -> int:
    if voltage not in VOLTAGE_BITS:
        raise ValueError(f"unknown reference voltage {voltage!r}")
    return VOLTAGE_BITS[voltage]


# ------------------------------------------------------------ flash (read)


def _read_flash(sub_command: int) -> list[int]:
    r = xfer(bytes([CMD_READ_FLASH, sub_command]))
    if r[1] != 0x00:
        raise RuntimeError(f"read flash 0x{sub_command:02x} failed with 0x{r[1]:02x}")
    return r


def _usb_string(sub_command: int) -> str:
    r = _read_flash(sub_command)
    length = r[2]
    if r[3] != USB_STRING_DESCRIPTOR_TYPE:
        raise RuntimeError(f"not a USB string descriptor (0x{r[3]:02x})")
    # Length counts the two header bytes; the payload is UTF-16LE.
    payload = bytes(r[4 : 4 + max(0, length - 2)])
    return payload.decode("utf-16-le", errors="replace")


@handler
def usb_descriptors() -> dict[str, Any]:
    """The descriptor strings and USB identity held in the chip's flash.

    Read-only: see the module docstring for why this page does not offer to
    rewrite them.
    """
    chip_settings = _read_flash(FLASH_CHIP_SETTINGS)
    factory = _read_flash(FLASH_FACTORY_SERIAL)
    factory_serial = bytes(factory[4 : 4 + factory[2]]).decode("ascii", errors="replace")

    power = chip_settings[12]
    return {
        "manufacturer": _usb_string(FLASH_USB_MANUFACTURER),
        "product": _usb_string(FLASH_USB_PRODUCT),
        "serialNumber": _usb_string(FLASH_USB_SERIAL),
        "factorySerialNumber": factory_serial,
        "vendorId": chip_settings[8] | (chip_settings[9] << 8),
        "productId": chip_settings[10] | (chip_settings[11] << 8),
        "selfPowered": bool(power & 0x40),
        "remoteWake": bool(power & 0x20),
        "mARequested": chip_settings[13] * 2,
        "chip": _decode_chip_byte(chip_settings[4]),
    }

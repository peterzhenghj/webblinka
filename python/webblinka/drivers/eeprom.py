"""Serial EEPROMs of the 24-series family: AT24C256 and relatives.

One driver covers the family, because they differ only in three numbers --
capacity, page size, and whether the word address is one byte or two. Adding a
part is adding a row to EEPROM_TYPES and a two-line subclass.

**Why not adafruit_24lc32.** It is a real I2C driver for a real member of this
family and it takes a max_size, so pointing it at a bigger part almost works.
But it deliberately avoids page writes -- it writes one byte at a time with a
flat 5 ms sleep after each. On an AT24C256 that is 32768 writes, so 164 seconds
of sleeping before any bus traffic, against 2.6 seconds page-at-a-time. Over
HID, where each byte write is several 64-byte reports as well, it is worse
still. Sixty-four times slower to do the same job is not a tradeoff worth
taking, so the page write is implemented here.

**Bank boundaries too.** A part with more storage than its word address can
reach borrows the low bits of the *I2C* address for the high bits of the memory
address, so a 24C16 answers on all eight of 0x50-0x57 and leaves no A-pin free
to move it. The count is not a per-part quirk but a rule, taken from Linux's
at24 driver: ceil(size / span) consecutive addresses, span being 64 KiB for a
two-byte word address and 256 bytes for a one-byte one. It follows that the
A-pins only reach the addresses a whole part fits in -- a 24C04 eats two, so it
can start at 0x50, 0x52, 0x54 or 0x56 and nowhere else.

**Page boundaries are the thing to get right.** A write that runs past the end
of a page does not continue into the next one -- the internal address counter
wraps to the *start of the same page* and overwrites what it just stored. It is
the classic way to corrupt an EEPROM, and it fails silently. write() splits
every transfer at page boundaries so callers never have to think about it, and
the panel draws the page grid so it is visible why they exist.
"""

from __future__ import annotations

import base64
import time
from typing import Any

from .base import Driver, register


class EepromSpec:
    """The three numbers that distinguish one 24-series part from another."""

    def __init__(
        self,
        *,
        label: str,
        size: int,
        page_size: int,
        address_bytes: int,
        write_ms: float = 5.0,
    ) -> None:
        self.label = label
        self.size = size
        self.page_size = page_size
        self.address_bytes = address_bytes
        self.write_ms = write_ms

    @property
    def span(self) -> int:
        """Bytes reachable from one I2C address before banking takes over."""
        return 65536 if self.address_bytes == 2 else 256

    @property
    def banks(self) -> int:
        """Consecutive I2C addresses the part occupies. Linux's at24 rule."""
        return max(1, -(-self.size // self.span))

    def base_addresses(self, first: int = 0x50, last: int = 0x57) -> list[int]:
        """Addresses the A-pins can actually put this part at.

        A part occupying several addresses has to start where the whole run
        fits, which is why a 24C16 has nowhere to go but 0x50.
        """
        return [a for a in range(first, last + 1, self.banks) if a + self.banks - 1 <= last]

    def as_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "size": self.size,
            "pageSize": self.page_size,
            "addressBytes": self.address_bytes,
            "pages": self.size // self.page_size,
            "banks": self.banks,
            "span": self.span,
        }


# Capacities are the part number's kilo*bits* over eight: a "256" is 32 KiB.
# Sizes and address widths follow Linux's at24 chip table; page sizes come from
# the datasheets, since at24 takes those from device tree rather than the part.
EEPROM_TYPES: dict[str, EepromSpec] = {
    # Two-byte word address, so one I2C address each up to 64 KiB.
    "at24c512": EepromSpec(label="AT24C512", size=64 * 1024, page_size=128, address_bytes=2),
    "at24c256": EepromSpec(label="AT24C256", size=32 * 1024, page_size=64, address_bytes=2),
    "at24c128": EepromSpec(label="AT24C128", size=16 * 1024, page_size=64, address_bytes=2),
    "at24c64": EepromSpec(label="AT24C64", size=8 * 1024, page_size=32, address_bytes=2),
    "24lc32": EepromSpec(label="24LC32", size=4 * 1024, page_size=32, address_bytes=2),
    # One-byte word address. Past 256 bytes these bank into extra I2C
    # addresses, which is what eats their A-pins.
    "at24c16": EepromSpec(label="AT24C16", size=2 * 1024, page_size=16, address_bytes=1),
    "at24c08": EepromSpec(label="AT24C08", size=1024, page_size=16, address_bytes=1),
    "at24c04": EepromSpec(label="AT24C04", size=512, page_size=16, address_bytes=1),
    "at24c02": EepromSpec(label="AT24C02", size=256, page_size=8, address_bytes=1),
    "at24c01": EepromSpec(label="AT24C01", size=128, page_size=8, address_bytes=1),
}

DEFAULT_ADDRESS = 0x50

# The MCP2221 caps a single I2C transfer at 60 bytes, so there is no point
# asking for more than that in one go -- Blinka would just chunk it anyway.
MAX_READ = 60

# A part still finishing its write cycle NACKs its address. Polling for the ACK
# is how you find out it is done, and is faster than assuming the worst case.
ACK_POLL_ATTEMPTS = 40


class SerialEeprom(Driver):
    """Base for the 24-series. Subclasses set SPEC."""

    SPEC: EepromSpec

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._device = None

    def start(self) -> dict[str, Any]:
        from adafruit_bus_device.i2c_device import I2CDevice

        # One handle per bank. I2CDevice probes on construction, so a part that
        # is absent, or smaller than the one selected, fails here rather than
        # returning 0xff for every byte -- which is exactly what a blank EEPROM
        # looks like, and so is worth telling apart.
        self._device = [
            I2CDevice(self.bus, self.address + bank) for bank in range(self.SPEC.banks)
        ]
        return {"address": self.address, **self.SPEC.as_dict()}

    def stop(self) -> None:
        self._device = None

    def _bank(self, offset: int):
        """The handle and word address for a byte, as at24_translate_offset does."""
        bank, word = divmod(offset, self.SPEC.span)
        return self._require()[bank], word

    def poll(self) -> dict[str, Any]:
        """EEPROMs have nothing to report over time; the panel reads on demand.

        Returning the geometry keeps the panel honest if it is reopened against
        a different part at the same address.
        """
        return {"address": self.address, **self.SPEC.as_dict()}

    def command(self, name: str, args: list[Any]) -> Any:
        if name == "read":
            return self._read(int(args[0]), int(args[1]))
        if name == "write":
            return self._write(int(args[0]), base64.b64decode(args[1]))
        if name == "fill":
            return self._write(int(args[0]), bytes([int(args[2]) & 0xFF]) * int(args[1]))
        return super().command(name, args)

    # ------------------------------------------------------------------ read

    def _read(self, offset: int, length: int) -> dict[str, Any]:
        self._check(offset, length)
        self._require()
        out = bytearray(length)

        # A sequential read needs the word address written once; the part then
        # streams from there, so the only chunking is the MCP2221's own limit.
        read = 0
        while read < length:
            here = offset + read
            handle, word = self._bank(here)
            # Never let one transfer cross a bank: some parts roll a sequential
            # read into the next slave address and some do not, and stopping at
            # the boundary is right for both.
            room = self.SPEC.span - word
            want = min(MAX_READ, length - read, room)
            chunk = bytearray(want)
            with handle:
                handle.write_then_readinto(self._word_address(word), chunk)
            out[read : read + want] = chunk
            read += want

        return {"offset": offset, "data": base64.b64encode(bytes(out)).decode("ascii")}

    # ----------------------------------------------------------------- write

    def _write(self, offset: int, data: bytes) -> dict[str, Any]:
        self._check(offset, len(data))
        self._require()
        page = self.SPEC.page_size

        written = 0
        pages = 0
        while written < len(data):
            here = offset + written
            handle, word = self._bank(here)
            # Stop at the next page boundary. Running past it would wrap to the
            # start of this page rather than continuing, silently overwriting
            # the bytes just stored. A bank is a whole number of pages, so this
            # keeps transfers inside a bank as well.
            room = page - (here % page)
            chunk = data[written : written + min(room, len(data) - written)]
            with handle:
                handle.write(self._word_address(word) + chunk)
            self._await_write(handle)
            written += len(chunk)
            pages += 1

        return {"offset": offset, "written": written, "pages": pages}

    def _await_write(self, handle) -> None:
        """Wait out the internal write cycle by polling for an ACK.

        The part stops answering its address entirely while it is writing, so a
        bare zero-length write either succeeds -- meaning it is ready -- or
        raises, meaning it is not.
        """
        for _ in range(ACK_POLL_ATTEMPTS):
            try:
                with handle:
                    handle.write(b"")
                return
            except OSError:
                time.sleep(self.SPEC.write_ms / 1000 / 4)
        raise RuntimeError(
            f"EEPROM at {self.address:#04x} never finished its write cycle -- "
            "is it write-protected?"
        )

    # --------------------------------------------------------------- helpers

    def _word_address(self, offset: int) -> bytes:
        if self.SPEC.address_bytes == 1:
            return bytes([offset & 0xFF])
        return bytes([(offset >> 8) & 0xFF, offset & 0xFF])

    def _check(self, offset: int, length: int) -> None:
        if offset < 0 or length < 0 or offset + length > self.SPEC.size:
            raise ValueError(
                f"{offset}+{length} is outside this {self.SPEC.size}-byte part"
            )

    def _require(self):
        if self._device is None:
            raise RuntimeError("EEPROM not started")
        return self._device


def _variant(device_id: str) -> None:
    """Register one part. The family differs only in EEPROM_TYPES."""
    spec = EEPROM_TYPES[device_id]
    register(device_id)(
        type(spec.label, (SerialEeprom,), {"SPEC": spec, "__doc__": f"{spec.label} EEPROM."})
    )


for _device_id in EEPROM_TYPES:
    _variant(_device_id)

"""A `hid` module backed by the browser's WebHID API.

Adafruit_Blinka's MCP2221 driver imports `hid` (the hidapi binding) and uses a
remarkably small slice of it: ``hid.enumerate()`` plus a ``hid.device`` with
open/write/read/close. That is the *only* native dependency standing between
stock Blinka and the browser, so shadowing this one module on sys.path is enough
to run the real, unforked library against real hardware over WebHID.

hidapi's calls are blocking. WebHID's are promises. ``run_sync`` bridges the two
by suspending the Python stack via WebAssembly JSPI (Chrome 137+) while the
worker's event loop round-trips the request to the page. From Blinka's point of
view nothing asynchronous ever happened.

Deliberately not implemented: feature reports, non-blocking mode, and multiple
concurrently open devices. Blinka's MCP2221 path uses none of them, and the
page only ever holds the one adapter the user picked.
"""

from __future__ import annotations

import js
from pyodide.ffi import run_sync

__all__ = ["HIDException", "device", "enumerate"]

# hidapi returns immediately when a report is already buffered; this bound only
# applies when we are genuinely waiting on the device. The MCP2221 answers every
# command in about a millisecond, so anything approaching this means trouble.
DEFAULT_TIMEOUT_MS = 2000


class HIDException(OSError):
    """Raised for transport failures.

    Subclasses OSError because Blinka's MCP2221._reset() catches OSError when
    polling for the device to come back.
    """


def enumerate(vendor_id: int = 0, product_id: int = 0) -> list[dict]:
    """List attached devices, filtered like hidapi's (0 means "any")."""
    devices = [dict(info) for info in run_sync(js.webblinkaHid.enumerate()).to_py()]
    return [
        info
        for info in devices
        if (not vendor_id or info["vendor_id"] == vendor_id)
        and (not product_id or info["product_id"] == product_id)
    ]


class device:  # noqa: N801 - hidapi spells it lowercase and Blinka calls hid.device()
    """A single open HID device."""

    def __init__(self, path: bytes | None = None) -> None:
        self._open = False
        if path is not None:
            self.open_path(path)

    def open(self, vendor_id: int, product_id: int) -> None:
        try:
            run_sync(js.webblinkaHid.open(vendor_id, product_id))
        except Exception as err:  # noqa: BLE001 - surfaced as hidapi's error type
            raise HIDException(str(err)) from err
        self._open = True

    def open_path(self, path: bytes) -> None:
        # Only one device is ever held, so every path resolves to the same one.
        del path
        self.open(0, 0)

    def write(self, data) -> int:
        """Send one output report. Byte 0 is the report ID, as in hidapi."""
        self._require_open()
        payload = js.Uint8Array.new(list(bytes(data)))
        try:
            return int(run_sync(js.webblinkaHid.write(payload)))
        except Exception as err:  # noqa: BLE001
            raise HIDException(str(err)) from err

    def read(self, size: int, timeout_ms: int | None = None) -> list[int]:
        """Block for one input report and return it as a list of ints."""
        self._require_open()
        timeout = DEFAULT_TIMEOUT_MS if timeout_ms in (None, 0) else int(timeout_ms)
        try:
            report = run_sync(js.webblinkaHid.read(size, timeout))
        except Exception as err:  # noqa: BLE001
            raise HIDException(str(err)) from err
        return list(report.to_py())[:size]

    def close(self) -> None:
        if not self._open:
            return
        self._open = False
        run_sync(js.webblinkaHid.close())

    def _require_open(self) -> None:
        if not self._open:
            raise HIDException("device is not open")

    # -- hidapi surface Blinka never touches, but drivers might ask about ----

    def set_nonblocking(self, nonblocking: int) -> None:
        if nonblocking:
            raise NotImplementedError("non-blocking reads are not supported over WebHID")

    def __enter__(self) -> "device":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

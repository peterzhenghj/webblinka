"""A registry of I2C device drivers, addressed generically from the page.

Supporting many devices means the page cannot know each one by name. A driver
registers itself here under an id, and the UI drives every device through the
same four calls -- start, poll, command, stop -- so adding a part is writing a
driver and a panel, never touching the RPC layer.

Instances are keyed by id *and* address, so two of the same part on one bus are
two independent instances rather than a name collision.
"""

from __future__ import annotations

from typing import Any, Callable

from ..rpc import handler
from ..session import i2c


class Driver:
    """One attached I2C device.

    Subclasses get the shared bus and their address, and are expected to leave
    the bus in a usable state -- nothing else on it stops existing while a
    driver is running.
    """

    def __init__(self, bus, address: int) -> None:
        self.bus = bus
        self.address = address

    def start(self) -> dict[str, Any]:
        """Configure the device. Returns anything the panel wants up front."""
        return {}

    def poll(self) -> dict[str, Any]:
        """Current readings, as JSON-serialisable values."""
        raise NotImplementedError

    def command(self, name: str, args: list[Any]) -> Any:
        """An action the panel can invoke by name."""
        raise LookupError(f"{type(self).__name__} has no command {name!r}")

    def stop(self) -> None:
        """Release anything held. The bus itself is shared, so leave it alone."""


_FACTORIES: dict[str, Callable[..., Driver]] = {}
_INSTANCES: dict[str, Driver] = {}


def register(device_id: str) -> Callable[[type[Driver]], type[Driver]]:
    """Class decorator making a driver reachable from the page."""

    def wrap(cls: type[Driver]) -> type[Driver]:
        _FACTORIES[device_id] = cls
        return cls

    return wrap


def _key(device_id: str, address: int) -> str:
    return f"{device_id}@{address:#04x}"


@handler
def device_ids() -> list[str]:
    """Every driver the runtime can instantiate."""
    return sorted(_FACTORIES)


@handler
def device_start(device_id: str, address: int) -> dict[str, Any]:
    factory = _FACTORIES.get(device_id)
    if factory is None:
        raise LookupError(f"no driver {device_id!r} (have {sorted(_FACTORIES)})")

    handle = _key(device_id, address)
    existing = _INSTANCES.pop(handle, None)
    if existing is not None:
        existing.stop()  # restarting is how a panel recovers from a bad state

    driver = factory(i2c(), address)
    info = driver.start()
    _INSTANCES[handle] = driver
    return {"handle": handle, "address": address, "info": info}


@handler
def device_poll(handle: str) -> dict[str, Any]:
    return _require(handle).poll()


@handler
def device_command(handle: str, name: str, args: list[Any] | None = None) -> Any:
    return _require(handle).command(name, args or [])


@handler
def device_stop(handle: str) -> None:
    driver = _INSTANCES.pop(handle, None)
    if driver is not None:
        driver.stop()


@handler
def device_active() -> list[str]:
    return sorted(_INSTANCES)


def _require(handle: str) -> Driver:
    driver = _INSTANCES.get(handle)
    if driver is None:
        raise RuntimeError(f"{handle} is not running -- open it first")
    return driver

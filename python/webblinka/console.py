"""An interactive escape hatch: run arbitrary Python, install arbitrary wheels.

The built-in panels cover the parts webblinka ships drivers for. This covers
everything else -- any of the hundreds of `adafruit-circuitpython-*` libraries
on PyPI, driven from a REPL with the live I2C bus already in scope.

Statements execute on the same stack-switching call as every other handler, so
`run_sync`-backed HID traffic works from the console exactly as it does from a
driver: write `import adafruit_bme280` and then read the sensor, synchronously.
"""

from __future__ import annotations

import contextlib
import io
import sys
import traceback
from typing import Any

from .rpc import handler

_globals: dict[str, Any] = {}


@handler
def console_reset() -> list[str]:
    """Start a fresh namespace pre-loaded with the usual CircuitPython names."""
    _globals.clear()
    _globals["__name__"] = "__console__"

    from . import session

    _globals["session"] = session
    for name in ("board", "busio", "digitalio", "analogio"):
        with contextlib.suppress(ImportError):
            _globals[name] = __import__(name)
    with contextlib.suppress(RuntimeError):
        _globals["i2c"] = session.i2c()

    return sorted(k for k in _globals if not k.startswith("__"))


@handler
def console_exec(source: str) -> dict[str, Any]:
    """Evaluate an expression, or execute statements, and capture the output."""
    if not _globals:
        console_reset()

    out = io.StringIO()
    try:
        try:
            code = compile(source, "<console>", "eval")
        except SyntaxError:
            # Not an expression -- run it for its side effects instead.
            code = compile(source, "<console>", "exec")
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                exec(code, _globals)  # noqa: S102 - this is the point of a console
            value = None
        else:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                value = eval(code, _globals)  # noqa: S307 - ditto
    except Exception:
        return {"output": out.getvalue(), "result": None, "error": traceback.format_exc()}

    _globals["_"] = value
    return {
        "output": out.getvalue(),
        "result": None if value is None else repr(value),
        "error": None,
    }


@handler
def install_package(spec: str) -> dict[str, Any]:
    """micropip-install a package from PyPI at runtime.

    The wheels webblinka's own panels need are vendored and served from the
    site, but the long tail of CircuitPython drivers is far too large to ship.
    This reaches PyPI directly, which is why it is an explicit user action
    rather than something that happens during boot.
    """
    import micropip
    from pyodide.ffi import run_sync

    before = set(micropip.list())
    run_sync(micropip.install(spec))
    installed = sorted(set(micropip.list()) - before)

    # A freshly installed package can shadow a module Python already imported.
    for name in list(sys.modules):
        if name.split(".")[0].replace("_", "-") in installed:
            del sys.modules[name]

    return {"requested": spec, "installed": installed}


@handler
def installed_packages() -> list[str]:
    import micropip

    return sorted(micropip.list())

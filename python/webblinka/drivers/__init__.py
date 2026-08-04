"""Per-device drivers backing the panels in the UI.

Each module wraps a stock CircuitPython library and exposes a tiny lifecycle --
start, poll, stop -- so the page can drive it on a timer without holding any
Python state of its own. The point is that the library underneath is exactly the
one you would `pip install` on a Raspberry Pi.
"""

__all__ = ["gps_pa1010d"]

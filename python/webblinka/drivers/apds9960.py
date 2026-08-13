"""APDS9960 proximity, gesture, RGB color and ambient light sensor."""

from __future__ import annotations

import time
from typing import Any

from .base import Driver, register

DEFAULT_ADDRESS = 0x39
GESTURE_HOLD_S = 3.0  


@register("apds9960")
class Apds9960(Driver):
    """Avago APDS-9960 via the stock adafruit_apds9960 library."""

    def __init__(self, bus, address: int = DEFAULT_ADDRESS) -> None:
        super().__init__(bus, address)
        self._sensor = None
        self._last_gesture = 0
        self._gesture_at = 0.0

    def start(self) -> dict[str, Any]:
        from adafruit_apds9960.apds9960 import APDS9960

        self._sensor = APDS9960(self.bus, address=self.address)
        self._sensor.enable_proximity = True
        self._sensor.enable_color = True
        self._last_gesture = 0
        self._gesture_at = 0.0
        return {"address": self.address}

    def stop(self) -> None:
        if self._sensor:
            self._sensor.enable = False
        self._sensor = None

    def poll(self) -> dict[str, Any]:
        sensor = self._require()

        result: dict[str, Any] = {
            "proximityEnabled": sensor.enable_proximity,
            "colorEnabled": sensor.enable_color,
            "gestureEnabled": sensor.enable_gesture,
            "proximity": None,
            "gesture": None,
            "color": None,
            "colorReady": False,
            "colorGain": sensor.color_gain,
        }

        if sensor.enable_proximity:
            result["proximity"] = int(sensor.proximity)

        if sensor.enable_color and sensor.color_data_ready:
            r, g, b, c = sensor.color_data
            result["color"] = {"r": r, "g": g, "b": b, "c": c}
            result["colorReady"] = True

        if sensor.enable_gesture:
            g = sensor.gesture()
            if g != 0:
                self._last_gesture = g
                self._gesture_at = time.monotonic()
            if time.monotonic() - self._gesture_at < GESTURE_HOLD_S:
                result["gesture"] = self._last_gesture

        return result

    def command(self, name: str, args: list[Any]) -> Any:
        sensor = self._require()

        if name == "enable_proximity":
            sensor.enable_proximity = bool(args[0])
        elif name == "enable_color":
            sensor.enable_color = bool(args[0])
        elif name == "enable_gesture":
            sensor.enable_gesture = bool(args[0])
            if bool(args[0]):
                sensor.enable_proximity = True  
        elif name == "set_color_gain":
            sensor.color_gain = int(args[0]) & 0x03  # 0=1x, 1=4x, 2=16x, 3=64x
        elif name == "clear_interrupt":
            sensor.clear_interrupt()
            return True
        else:
            return super().command(name, args)

        return self.poll()

    def _require(self):
        if self._sensor is None:
            raise RuntimeError("APDS9960 not started")
        return self._sensor
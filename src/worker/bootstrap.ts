/** Where the bundled python/ tree is written inside the Pyodide filesystem. */
export const PY_ROOT = "/webblinka";

/**
 * Prelude run once, before anything imports `board`. Shared by the browser
 * worker and the Node test harness so both bring Blinka up identically.
 *
 * The caller must have installed `webblinkaHid` and `webblinkaSleep` on
 * globalThis first -- python/hid.py reaches for them.
 */
export function bootstrapSource(pyRoot: string = PY_ROOT): string {
  return `
import os, sys, time
import js
from pyodide.ffi import run_sync

sys.path.insert(0, ${JSON.stringify(pyRoot)})

# Tell PlatformDetect to skip its /proc probing and go straight to the MCP2221
# path, and tell Blinka not to reset the chip on init: a reset re-enumerates the
# USB device, which would invalidate the HIDDevice handle the page is holding.
# webblinka.session cancels any stuck I2C transfer instead.
os.environ["BLINKA_MCP2221"] = "1"
os.environ["BLINKA_MCP2221_RESET_DELAY"] = "-1"

_builtin_sleep = time.sleep


def _yielding_sleep(seconds):
    """Blinka's I2C retry loops sleep; Pyodide's time.sleep busy-waits.

    Busy-waiting here would starve the event loop that delivers HID replies, so
    hand control back to it instead.
    """
    if seconds <= 0:
        return
    try:
        run_sync(js.webblinkaSleep(seconds * 1000))
    except Exception:
        # Not inside a stack-switching call (during an import, say); busy-waiting
        # is correct-if-wasteful there because nothing is awaiting a reply.
        _builtin_sleep(seconds)


time.sleep = _yielding_sleep
`;
}

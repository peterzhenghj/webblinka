# webblinka

Run Adafruit's CircuitPython libraries in a browser tab, driving real I²C parts
and GPIO through an [MCP2221][mcp2221] USB adapter over WebHID. No server, no
install, no firmware — open the page, click Connect, and `import board` works.

The Blinka stack is **unmodified**. `adafruit-blinka`,
`adafruit-circuitpython-gps` and friends are installed straight from their PyPI
wheels. The only thing this project had to write is a `hid` module.

## How it works

Blinka's MCP2221 driver needs exactly one native dependency: a module named
`hid`, of which it uses `enumerate()` plus a device with
`open`/`write`/`read`/`close`. [`python/hid.py`](python/hid.py) reimplements that
slice on top of WebHID and shadows the real package on `sys.path`. Nothing else
about Blinka changes.

The awkward part is that hidapi's calls are blocking while WebHID's are
promises. [WebAssembly JSPI][jspi] resolves it: Pyodide's `run_sync()` suspends
the Python stack mid-call, the browser resolves the promise, and Python resumes
none the wiser. That is also why there is no SharedArrayBuffer here — and so no
COOP/COEP headers, which GitHub Pages cannot set anyway.

```
main thread                          dedicated worker
───────────                          ────────────────
UI panels (plain TS)                 Pyodide
  │                                    ├─ hid.py  (shim on sys.path)
  ├── navigator.hid.requestDevice()    ├─ adafruit_blinka (stock, from a wheel)
  │     (needs a user gesture)         └─ webblinka/session.py + drivers/
  │
  └── HidTransport ◄──── postMessage ────► run_sync(promise)
        ├─ WebHidTransport (real device)
        └─ EmulatorTransport (demo mode / CI)
```

Python runs in a worker so a runaway driver loop cannot freeze the page. WebHID
stays on the main thread because `requestDevice()` needs a user gesture, so each
64-byte report round-trips over `postMessage` — invisible to Blinka thanks to
JSPI.

**Calls into Python are serialised** ([`serialize.ts`](src/worker/serialize.ts)).
The chip has one command pipeline and one I²C engine, and a suspended JSPI stack
lets the worker start a second call while the first is mid-transfer — so two
overlapping calls interleave on that one pipeline and read each other's replies.
The unit of atomicity is a whole driver operation, not a transfer, so the queue
lives at the call boundary. Panels that poll skip a tick rather than queue behind
a slow operation.

**Requirements: Chrome or Edge 137+ on desktop.** WebHID is Chromium-only and
JSPI shipped in 137. The site says so plainly if either is missing.

## The tabs

Laid out after [johntalton/webapp-device-playground][playground], which gets the
shape of an adapter UI right.

- **Common** — the Status/Set Parameters report, polled once a second: the I²C
  engine's state machine, the interrupt latch, silicon revision, and ADC counts
  for whichever pins are currently designated as ADCs. The converter is not
  wired to a pin doing anything else, so those channels are hidden rather than
  reporting a number that means nothing.
- **USB Descriptors** — the identity in the chip's flash. Read-only; see
  [`mcp2221_chip.py`](python/webblinka/mcp2221_chip.py) for why.
- **GPIO** — every pin designation the chip offers, not just in/out: SSPND,
  USBCFG, the UART Rx/Tx and I²C activity LEDs, the clock output, interrupt on
  change, ADC and DAC. Plus the chip-wide clock, reference-voltage and
  interrupt-edge settings those designations depend on.
- **I²C** — bus scan, and the GPS panel. That one leads with the sky view —
  a signal-strength bar per satellite, greyed while too weak to use, amber once
  usable, green once actually in the solution — because an acquiring receiver
  and a broken one look identical for the first half-minute unless you can watch
  the satellites arrive. Alongside it: time to first fix, satellites used versus
  in view, PDOP/HDOP/VDOP, and the raw NMEA. Once there is a fix it also plots
  the position scatter — where successive fixes land, in metres, against the
  HDOP-derived error estimate. That comparison is the useful one: a street map
  would show a single dot that never moves, whereas the size and shape of the
  cloud is the receiver's actual precision. No tiles, so no third party is told
  where the receiver is on every fix; there is a link out for when you do want
  streets, and following it is a decision rather than a side effect.
- **Devices** — every I²C part with a driver, opened on request from the I²C
  tab. Each gets its own tab:
  - **PA1010D GPS** — see above.
  - **AHT10 / AHT20** — temperature and humidity, plus the dew point and
    absolute humidity the part does not measure, and a five-minute trend. The
    trend earns its place: an AHT10 self-heats, so for a minute or two after
    power-up it reads high on temperature and low on humidity, and a single
    number gives no way to tell a settled reading from one still coming down.
    The panel says which, and warns when the dew point is close enough to
    ambient that surfaces will wet.
- **Python** — the REPL and the PyPI installer.

`input`/`output`/`analog_in`/`analog_out` go through `digitalio` and `analogio`,
because running the real CircuitPython API is the point. The rest are chip
functions CircuitPython has no vocabulary for, so
[`mcp2221_chip.py`](python/webblinka/mcp2221_chip.py) speaks the datasheet's
report protocol over the HID transport Blinka already owns. Still no fork.

## When the bus misbehaves

Any failed call into Python dumps the last two dozen HID transfers to the log —
command, reply, and the I²C engine state the chip reported. So does any report
that the bus is unhealthy, even when nothing threw: a chip claiming to be wedged
on a free bus is at least as likely to be us misreading the reply as it is to be
the hardware. Python's traceback tells you which line raised; only the bytes tell
you why, which matters when the hardware is on someone else's desk.

Two rules about not provoking the chip, both learned by breaking it:

**Look before you cancel.** Cancelling drives a STOP, and an idle engine has no
transaction for that STOP to terminate — on a quiet bus it times out, and a chip
that was fine now reports `stop timeout`. `force_idle()` reads the status first
and only cancels if there is something to cancel.

**Then cancel once.** Re-sending it on every poll re-triggers the wind-down being
waited on, pinning the engine in the state it is trying to leave.

`Mcp2221Emulator.stopTimeoutOnSpuriousCancel` and `.cancelRestartsOnRepeat` model
both, and both default to on: code that only works against the forgiving reading
of the datasheet is code that breaks on real hardware.

The engine's state byte is **not** treated as evidence of a fault. It reports the
last thing the engine did, and a NACKed probe or a late cancel leaves a code
sitting there that clears on the next transfer — Blinka itself just cancels and
carries on. Only a line held low gets reported as a problem, because that is
measurable and unambiguous.

The MCP2221's cancel is a request the engine takes a few hundred microseconds to
honour. Blinka waits a flat millisecond and then issues its next command, so when
the wind-down runs long the command is rejected as busy and Blinka reads that as
`Unrecoverable I2C state failure`. `force_idle()` polls until the engine really
is idle instead of assuming, and the scan recovers per-address rather than
abandoning the sweep. `Mcp2221Emulator.cancelLatency` reproduces the window.

Some states no cancel can reach — a transfer abandoned mid-flight leaves the
engine trying to issue a STOP forever, and it survives page reloads because
webblinka does not reset the chip at startup the way Blinka does (a reset drops
the device off USB, invalidating the page's `HIDDevice`). **Reset chip** does it
properly: resets, waits for the re-enumerated device, swaps the handle
underneath Python, and re-reads the chip's real pin configuration into Blinka's
cache. `Mcp2221Emulator.wedge()` reproduces the state.

Which of the two you have is decided by the SCL/SDA levels, which is why they
are reported rather than guessed at. Both high means the bus is free and the
chip is stuck, so a reset fixes it. Either low means a device is holding a line
down, and resetting the MCP2221 cannot release someone else's line — that one is
wiring or pull-ups.

Scanning is not automatic on connect: it writes to every address on the bus, so
it happens when you open the I²C tab, and again whenever you press Scan.

## Demo mode

Marked everywhere it appears — a banner, a `· simulated` suffix on every panel
heading, and a status pill that says Demo rather than Connected. The readings
are indistinguishable from real ones by construction, which is the point of the
emulator and also its hazard: an invented GPS fix reads exactly like a receiver
reporting the wrong place.


No adapter? [`src/hid/mcp2221-emulator.ts`](src/hid/mcp2221-emulator.ts) is a
software MCP2221 speaking the same HID command protocol, with a synthetic
PA1010D GPS on its I²C bus that acquires a fix over the first few seconds. The
same emulator backs the test suite, so CI exercises the full stack — Pyodide,
the shim, JSPI, stock Blinka — with no hardware attached.

## Development

Node comes from `.nvmrc` and must be new enough for unflagged JSPI (Node 24 is
not; 25 and later are). Python only ever runs inside Pyodide, so uv's only job
here is fetching the vendored wheels.

```bash
nvm use && npm install
```

| command | what it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm test` | full stack in Node against the emulator |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | typecheck + production build into `dist/` |
| `npm run wheels` | re-vendor `public/wheels/` via `uv` |

Imports carry explicit `.ts` extensions so Node can run `src/` directly with its
built-in type stripping — that is how the tests exercise the real emulator and
bootstrap code rather than a copy of them.

### Adding a device

Three pieces, and nothing else changes — not the RPC layer, not the tab shell,
not the scanner:

1. A `Driver` subclass in [`python/webblinka/drivers/`](python/webblinka/drivers/)
   with `start` / `poll` / `command` / `stop`, decorated `@register("your-id")`,
   and imported in `rpc.py`'s `_load_handlers`.
2. A panel implementing [`DevicePanel`](src/devices/panel.ts). It is handed a
   session bound to one running instance and never learns its own address or
   handle, so the same class serves two of the same part on one bus.
3. An entry in [`src/devices/catalog.ts`](src/devices/catalog.ts) listing every
   I²C address the part can answer at.

The addresses are what connect a scan to a panel. A scan proposes matching
devices and the person decides — an address only says *something* answered, and
parts share addresses, so detection is never taken as identification. Nothing
talks to a device until you open it, which matters because starting a driver
configures the part.

If you add a wheel, remember `scripts/fetch_wheels.py`.

A panel that polls must stop on `hide()` — every tick is real traffic competing
for the bus. And add a `VirtualI2cDevice` under `src/hid/devices/` so the part
works in demo mode and in CI without hardware.

See [`gps_pa1010d.py`](python/webblinka/drivers/gps_pa1010d.py) and
[`gps.ts`](src/ui/panels/gps.ts) for the shape.

### Adding a chip-level panel

Panels for the MCP2221 itself — rather than something on its bus — are plain
`@handler` functions plus a static tab in `src/ui/app.ts`. GPIO and Common work
this way.

## Deployment

`.github/workflows/deploy.yml` runs the test suite and publishes `dist/` to
GitHub Pages on pushes to `main`. The Vite `base` defaults to `/webblinka/` for
project pages; set `BASE_PATH=/` for a custom domain or a user/org page.

Pyodide's ~10MB runtime loads from the jsDelivr CDN. The ~1.4MB of CircuitPython
wheels are vendored in `public/wheels/` and served from the site itself, so a
cold start does not depend on PyPI.

[mcp2221]: https://www.microchip.com/en-us/product/MCP2221
[jspi]: https://developer.chrome.com/blog/webassembly-jspi
[playground]: https://github.com/johntalton/webapp-device-playground

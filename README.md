# webblinka

Run Adafruit's CircuitPython libraries in a browser tab, driving real I2C parts
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

- **Common** — the Status/Set Parameters report, polled once a second: live ADC
  counts, the I²C engine's state machine, the interrupt latch, silicon revision.
- **USB Descriptors** — the identity in the chip's flash. Read-only; see
  [`mcp2221_chip.py`](python/webblinka/mcp2221_chip.py) for why.
- **GPIO** — every pin designation the chip offers, not just in/out: SSPND,
  USBCFG, the UART Rx/Tx and I²C activity LEDs, the clock output, interrupt on
  change, ADC and DAC. Plus the chip-wide clock, reference-voltage and
  interrupt-edge settings those designations depend on.
- **I²C** — bus scan and the GPS panel.
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

Waiting for the engine to go idle sends the cancel **once** and then polls with a
plain status read. Re-sending it every poll re-triggers the wind-down being
waited on — releasing the bus goes through a STOP — so the loop pins the engine
in the state it is trying to leave and reports a healthy chip as stuck.
`Mcp2221Emulator.cancelRestartsOnRepeat` models that, and defaults to on: code
that only works against the forgiving interpretation is code that breaks on real
hardware.

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

No adapter? [`src/hid/mcp2221-emulator.ts`](src/hid/mcp2221-emulator.ts) is a
software MCP2221 speaking the same HID command protocol, with a synthetic
PA1010D GPS on its I2C bus that acquires a fix over the first few seconds. The
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

### Adding a device panel

1. Write a driver in `python/webblinka/drivers/` that wraps the stock
   CircuitPython library and exposes `@handler` functions returning JSON-able
   values. Register it in `python/webblinka/rpc.py`.
2. Add its wheel to `REQUIREMENTS` in `scripts/fetch_wheels.py` and re-run
   `npm run wheels`.
3. Add a panel under `src/ui/panels/` and give it a tab in `src/ui/app.ts`. A
   panel that polls should stop on the tab's `onHide` — every tick is real
   traffic competing for the bus.
4. For demo mode and tests, add a `VirtualI2cDevice` under `src/hid/devices/`.

See [`gps_pa1010d.py`](python/webblinka/drivers/gps_pa1010d.py) and
[`gps.ts`](src/ui/panels/gps.ts) for the shape.

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

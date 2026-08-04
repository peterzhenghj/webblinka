import { EmulatorTransport } from "../hid/emulator.ts";
import type { HidTransport } from "../hid/transport.ts";
import {
  WebHidTransport,
  grantedMcp2221s,
  isWebHidAvailable,
  requestMcp2221,
} from "../hid/webhid.ts";
import { vendoredWheelUrls } from "../wheels.ts";
import { PythonSession } from "../worker/client.ts";
import { BOOT_PHASE_LABELS } from "../worker/protocol.ts";
import { el } from "./dom.ts";
import { statusPill } from "./panel.ts";
import {
  CommonPanel,
  type BoardInfo,
  type BusState,
  type ChipStatus,
  type RuntimeInfo,
} from "./panels/common.ts";
import { ConsolePanel, type ConsoleResult } from "./panels/console.ts";
import { DescriptorsPanel, type UsbDescriptors } from "./panels/descriptors.ts";
import {
  GpioPanel,
  type GpSettings,
  type PinModeSpec,
  type PinState,
} from "./panels/gpio.ts";
import { GpsPanel, type GpsState } from "./panels/gps.ts";
import { I2cPanel } from "./panels/i2c.ts";
import { LogPanel } from "./panels/log.ts";
import { Tabs } from "./tabs.ts";

const PA1010D_ADDRESS = 0x10;

/** JSPI is what lets synchronous Blinka code await WebHID. Chrome 137+. */
function hasJspi(): boolean {
  return typeof WebAssembly.Suspending === "function";
}

export function mount(root: HTMLElement): void {
  const session = new PythonSession();
  const status = statusPill("Disconnected");
  const log = new LogPanel();

  const common = new CommonPanel({
    status: () => session.call<ChipStatus>("chip_status"),
    clearInterrupt: () => session.call<void>("clear_interrupt"),
  });

  const descriptors = new DescriptorsPanel({
    read: () => session.call<UsbDescriptors>("usb_descriptors"),
  });

  const gpio = new GpioPanel({
    modes: () => session.call<Record<string, PinModeSpec[]>>("gpio_modes"),
    configure: (name, mode) => session.call<PinState>("gpio_configure", name, mode),
    release: (name) => session.call<void>("gpio_release", name),
    write: (name, value) => session.call<PinState>("gpio_write", name, value),
    readAll: () => session.call<PinState[]>("gpio_read_all"),
    settings: () => session.call<{ gp: GpSettings }>("sram_settings"),
    setClock: (duty, divider) => session.call("set_clock_output", duty, divider),
    setDacReference: (v, o) => session.call("set_dac_reference", v, o),
    setDacValue: (value) => session.call("set_dac_value", value),
    setAdcReference: (v, o) => session.call("set_adc_reference", v, o),
    setInterruptEdge: (edge) => session.call("set_interrupt_edge", edge),
  });

  const gps = new GpsPanel({
    start: (address) => session.call<{ address: number }>("gps_start", address),
    poll: () => session.call<GpsState>("gps_poll"),
    stop: () => session.call<void>("gps_stop"),
  });

  const i2c = new I2cPanel({
    scan: async () => {
      const found = await session.call<number[]>("i2c_scan");
      gps.setPresent(found.includes(PA1010D_ADDRESS));
      return found;
    },
    setFrequency: async (hz) => void (await session.call("set_i2c_frequency", hz)),
  });

  const console_ = new ConsolePanel({
    exec: (source) => session.call<ConsoleResult>("console_exec", source),
    reset: () => session.call<string[]>("console_reset"),
    install: (spec) =>
      session.call<{ requested: string; installed: string[] }>("install_package", spec),
  });

  const tabs = new Tabs([
    {
      id: "common",
      label: "Common",
      content: common.root,
      onShow: () => common.start(),
      onHide: () => common.stop(),
    },
    {
      id: "descriptors",
      label: "USB Descriptors",
      content: descriptors.root,
      onShow: () => void descriptors.load(),
    },
    {
      id: "gpio",
      label: "GPIO",
      content: gpio.root,
      onShow: () => gpio.show(),
      onHide: () => gpio.hide(),
    },
    {
      id: "i2c",
      label: "I²C",
      content: el("div", {}, [i2c.root, gps.root]),
      // Scanning writes to every address on the bus, so it happens when you ask
      // to look at the bus -- not as a side effect of plugging something in.
      onShow: () => void i2c.scanOnce(),
    },
    { id: "python", label: "Python", content: console_.root },
  ]);

  const connect = el("button", { class: "primary", text: "Connect MCP2221" });
  const demo = el("button", { text: "Run the demo instead" });
  const reset = el("button", {
    text: "Reset chip",
    hidden: true,
    title:
      "Resets the MCP2221. Clears an I²C engine stuck somewhere a cancel cannot " +
      "reach — the software equivalent of unplugging it.",
  });
  const intro = el("div", { class: "body" }, [
    el("p", {
      class: "hint",
      text:
        "Plug in an MCP2221 or MCP2221A and grant access. Adafruit's Blinka and " +
        "CircuitPython libraries run unmodified in a Python runtime inside this " +
        "page and talk to the chip over WebHID — no server, no install.",
    }),
    el("div", { class: "controls" }, [connect, demo, reset]),
  ]);

  root.replaceChildren(
    el("div", { class: "masthead" }, [
      el("div", {}, [
        el("h1", { text: "webblinka" }),
        el("p", { text: "CircuitPython drivers, in the browser, driving real I2C hardware." }),
      ]),
    ]),
    el("section", { class: "panel" }, [
      el("header", {}, [el("h2", { text: "Connection" }), status.node]),
      intro,
    ]),
    tabs.root,
    log.root,
  );

  const ui: Ui = {
    connect,
    demo,
    reset,
    status,
    log,
    tabs,
    common,
    gpio,
    i2c,
    console: console_,
  };

  reset.addEventListener("click", () => void resetChip(session, ui));

  session.on("status", (phase) => status.set(`${BOOT_PHASE_LABELS[phase]}…`, "busy"));
  session.on("log", (stream, text) => log.write(text, stream));

  demo.addEventListener("click", () => {
    log.write("Starting in demo mode: emulated MCP2221 with a PA1010D on the bus.");
    void start(session, ui, new EmulatorTransport(), "emulated MCP2221");
  });

  const blocker = unsupportedReason();
  if (blocker) {
    // Demo mode still needs JSPI -- it is Python doing the driving either way --
    // so only WebHID's absence leaves it usable.
    connect.disabled = true;
    status.set("Unsupported", "error");
    intro.append(el("div", { class: "notice", dataset: { tone: "error" }, text: blocker }));
    if (!hasJspi() || !window.isSecureContext) demo.disabled = true;
    return;
  }

  connect.addEventListener("click", () => void connectHardware(session, ui));
  void grantedMcp2221s().then((devices) => {
    if (devices.length > 0) connect.textContent = "Reconnect MCP2221";
  });
}

interface Ui {
  connect: HTMLButtonElement;
  demo: HTMLButtonElement;
  reset: HTMLButtonElement;
  status: ReturnType<typeof statusPill>;
  log: LogPanel;
  tabs: Tabs;
  common: CommonPanel;
  gpio: GpioPanel;
  i2c: I2cPanel;
  console: ConsolePanel;
}

async function connectHardware(session: PythonSession, ui: Ui): Promise<void> {
  ui.connect.disabled = true;
  const granted = await grantedMcp2221s();
  const device = granted[0] ?? (await requestMcp2221());
  if (!device) {
    ui.status.set("No device selected", "idle");
    ui.connect.disabled = false;
    return;
  }
  ui.log.write(`Selected ${device.productName || "MCP2221"}.`);
  await start(session, ui, new WebHidTransport(device), device.productName || "MCP2221");
}

async function start(
  session: PythonSession,
  ui: Ui,
  transport: HidTransport,
  label: string,
): Promise<void> {
  ui.connect.disabled = true;
  ui.demo.disabled = true;
  try {
    session.useTransport(transport);
    await session.boot(await vendoredWheelUrls());

    const board = await session.call<BoardInfo>("connect");
    const runtime = await session.call<RuntimeInfo>("runtime_info");
    ui.common.showBoard(board, runtime);
    ui.i2c.enable();
    await ui.gpio.enable();
    await ui.console.enable();
    ui.tabs.enable();
    ui.reset.hidden = false;
    ui.status.set(`Connected — ${label}`, "ok");
    ui.log.write(`Blinka ${runtime.blinka} on Python ${runtime.python}, chip ${board.chip}.`);
    reportBusState(ui, session, board.bus);
  } catch (err) {
    ui.status.set("Failed", "error");
    ui.log.write(err instanceof Error ? err.message : String(err), "stderr");
    ui.connect.disabled = false;
    ui.demo.disabled = false;
  }
}

/**
 * Say what the bus is actually doing rather than guessing at it. The two lines
 * separate the two causes: both high and the bus is free, so the chip itself is
 * stuck and a reset fixes it; either low and a device is holding the line, which
 * no amount of resetting the MCP2221 will change.
 */
function reportBusState(ui: Ui, session: PythonSession, bus: BusState): void {
  if (bus.idle) return;
  const lines = `SCL ${bus.scl ? "high" : "low"}, SDA ${bus.sda ? "high" : "low"}`;
  const held = !bus.scl || !bus.sda;
  ui.log.write(
    `I²C engine is stuck in "${bus.state}" and would not cancel (${lines}). ` +
      (held
        ? "A device on the bus is holding a line low. Check wiring and pull-ups; " +
          "resetting the MCP2221 will not release someone else's line."
        : "The bus itself is free, so this is the chip rather than the wiring — " +
          "press Reset chip."),
    "stderr",
  );
  // Nothing threw, so no traceback carries the trace. Report it anyway: a chip
  // that says it is wedged on a free bus is at least as likely to be us
  // misreading the reply as it is to be the hardware.
  ui.log.write(session.trace.format(), "stderr");
}

async function resetChip(session: PythonSession, ui: Ui): Promise<void> {
  ui.reset.disabled = true;
  // Nothing may talk to the device while it is away.
  ui.common.stop();
  ui.gpio.hide();
  ui.status.set("Resetting…", "busy");
  ui.log.write("Resetting the chip; it will drop off USB and re-enumerate.");
  try {
    // The reply never comes -- the device is gone before it could send one --
    // and the send itself may fail for the same reason. Both are success here.
    await session.call("reset_chip").catch(() => undefined);
    await session.reacquire();
    const bus = await session.call<BusState>("rebuild_bus");
    await ui.gpio.enable(); // a reset put every pin back to its flash default
    ui.status.set("Connected", "ok");
    ui.log.write(`Chip is back, I²C engine ${bus.state}.`);
    reportBusState(ui, session, bus);
  } catch (err) {
    ui.status.set("Reset failed", "error");
    ui.log.write(err instanceof Error ? err.message : String(err), "stderr");
  } finally {
    ui.reset.disabled = false;
  }
}

function unsupportedReason(): string | null {
  if (!window.isSecureContext) {
    return "WebHID needs a secure context. Load this page over HTTPS or from localhost.";
  }
  if (!hasJspi()) {
    return (
      "This browser lacks WebAssembly JavaScript Promise Integration, which is " +
      "what lets synchronous CircuitPython code wait on WebHID. Chrome 137 or " +
      "newer is required."
    );
  }
  if (!isWebHidAvailable()) {
    return (
      "This browser has no WebHID support, so it cannot reach an MCP2221. " +
      "You can still run the demo, which emulates one in software."
    );
  }
  return null;
}

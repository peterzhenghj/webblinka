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
    { id: "i2c", label: "I²C", content: el("div", {}, [i2c.root, gps.root]) },
    { id: "python", label: "Python", content: console_.root },
  ]);

  const connect = el("button", { class: "primary", text: "Connect MCP2221" });
  const demo = el("button", { text: "Run the demo instead" });
  const intro = el("div", { class: "body" }, [
    el("p", {
      class: "hint",
      text:
        "Plug in an MCP2221 or MCP2221A and grant access. Adafruit's Blinka and " +
        "CircuitPython libraries run unmodified in a Python runtime inside this " +
        "page and talk to the chip over WebHID — no server, no install.",
    }),
    el("div", { class: "controls" }, [connect, demo]),
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

  const ui: Ui = { connect, demo, status, log, tabs, common, gpio, i2c, console: console_ };

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
    ui.status.set(`Connected — ${label}`, "ok");
    ui.log.write(`Blinka ${runtime.blinka} on Python ${runtime.python}, chip ${board.chip}.`);

    await ui.i2c.scan();
  } catch (err) {
    ui.status.set("Failed", "error");
    ui.log.write(err instanceof Error ? err.message : String(err), "stderr");
    ui.connect.disabled = false;
    ui.demo.disabled = false;
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

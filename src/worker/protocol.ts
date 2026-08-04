import type { HidDeviceInfo, Report } from "../hid/transport.ts";

/**
 * Two request/response flows share the one worker port, in opposite directions:
 * the page calls Python (`call` -> `reply`), and Python calls HID (`hid` ->
 * `hidReply`). Python's side of the second flow is synchronous -- it suspends
 * via JSPI while the reply travels -- so the worker must never block its own
 * message loop, which is what delivers that reply.
 */

export type HidRequest =
  | { op: "enumerate" }
  | { op: "open"; vendorId: number; productId: number }
  | { op: "write"; data: Report }
  | { op: "read"; length: number; timeoutMs: number }
  | { op: "close" };

export type HidResponse = HidDeviceInfo[] | number | Report | null;

export type ToWorker =
  | { kind: "boot"; pyodideIndexUrl: string; wheelUrls: string[] }
  | { kind: "call"; id: number; fn: string; args: unknown[] }
  | { kind: "hidReply"; id: number; ok: true; value: HidResponse }
  | { kind: "hidReply"; id: number; ok: false; error: string };

export type FromWorker =
  | { kind: "status"; phase: BootPhase; detail?: string }
  | { kind: "ready"; pyodideVersion: string; pythonVersion: string }
  | { kind: "bootFailed"; error: string }
  | { kind: "log"; stream: "stdout" | "stderr"; text: string }
  | { kind: "reply"; id: number; ok: true; value: unknown }
  | { kind: "reply"; id: number; ok: false; error: string }
  | { kind: "hid"; id: number; request: HidRequest };

export type BootPhase =
  | "loading-runtime"
  | "installing-packages"
  | "starting-blinka"
  | "ready";

export const BOOT_PHASE_LABELS: Record<BootPhase, string> = {
  "loading-runtime": "Loading Python runtime",
  "installing-packages": "Installing CircuitPython libraries",
  "starting-blinka": "Starting Blinka",
  ready: "Ready",
};

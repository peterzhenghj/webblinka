/**
 * The contract between a device panel and the shell.
 *
 * A panel is handed a session bound to one running driver instance and never
 * learns its own I2C address, device id or handle -- so the same panel class
 * serves two of the same part on one bus without knowing it.
 */
export interface DevicePanel {
  readonly root: HTMLElement;
  /** The tab became visible. Start polling here, not in the constructor. */
  show(): void;
  /** The tab was hidden or closed. Stop polling; every tick is bus traffic. */
  hide(): void;
}

/** One running driver instance, as a panel sees it. */
export interface DeviceSession {
  /** Readings from the driver's poll(). */
  poll<T>(): Promise<T>;
  /** Invoke a named action the driver exposes. */
  command<T>(name: string, ...args: unknown[]): Promise<T>;
  /** The address this instance was opened at, for display. */
  readonly address: number;
}

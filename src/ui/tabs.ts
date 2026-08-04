import { el } from "./dom.ts";

export interface TabSpec {
  id: string;
  label: string;
  content: HTMLElement;
  /** Called the first time the tab is shown, and on every show after that. */
  onShow?: () => void;
  /** Called when the tab is hidden, so panels can stop their polling. */
  onHide?: () => void;
}

/**
 * A plain tab strip. Inactive panels stay in the DOM but hidden, so a tab keeps
 * its scroll position and its readouts; onShow/onHide let a panel start and
 * stop polling instead, because every poll is real traffic over the bus.
 */
export class Tabs {
  readonly root: HTMLElement;
  readonly #strip: HTMLElement;
  readonly #panels: HTMLElement;
  readonly #tabs: TabSpec[];
  readonly #buttons = new Map<string, HTMLButtonElement>();
  #active: string | null = null;
  #enabled = false;

  constructor(tabs: TabSpec[]) {
    this.#tabs = tabs;
    this.#strip = el("div", { class: "tabstrip", role: "tablist" });
    this.#panels = el("div", { class: "tabpanels" });

    for (const tab of tabs) {
      this.#strip.append(this.#button(tab));
      tab.content.setAttribute("role", "tabpanel");
      tab.content.hidden = true;
      this.#panels.append(tab.content);
    }

    this.root = el("div", { class: "tabs" }, [this.#strip, this.#panels]);
  }

  #button(tab: TabSpec): HTMLButtonElement {
    const button = el("button", {
      class: "tabstrip-button",
      text: tab.label,
      type: "button",
      role: "tab",
      disabled: true,
    });
    button.addEventListener("click", () => this.select(tab.id));
    this.#buttons.set(tab.id, button);
    return button;
  }

  /** Tabs stay disabled until there is a device to talk to. */
  enable(): void {
    this.#enabled = true;
    for (const button of this.#buttons.values()) button.disabled = false;
    if (this.#active === null) this.select(this.#tabs[0]?.id ?? "");
  }

  has(id: string): boolean {
    return this.#buttons.has(id);
  }

  /**
   * Append a tab at runtime, for a device the user has just opened. Devices are
   * discovered by scanning, so the strip cannot be known up front.
   */
  add(tab: TabSpec, { select = false } = {}): void {
    if (this.#buttons.has(tab.id)) {
      if (select) this.select(tab.id);
      return;
    }
    this.#tabs.push(tab);
    const button = this.#button(tab);
    button.disabled = !this.#enabled;
    this.#strip.append(button);
    tab.content.setAttribute("role", "tabpanel");
    tab.content.hidden = true;
    this.#panels.append(tab.content);
    if (select) this.select(tab.id);
  }

  remove(id: string): void {
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const [tab] = this.#tabs.splice(index, 1);
    if (this.#active === id) {
      tab?.onHide?.();
      this.#active = null;
    }
    this.#buttons.get(id)?.remove();
    this.#buttons.delete(id);
    tab?.content.remove();
    // Land somewhere sensible rather than on a blank shell.
    if (this.#active === null) this.select(this.#tabs[Math.max(0, index - 1)]?.id ?? "");
  }

  select(id: string): void {
    if (id === this.#active) return;
    for (const tab of this.#tabs) {
      const active = tab.id === id;
      const button = this.#buttons.get(tab.id);
      tab.content.hidden = !active;
      button?.toggleAttribute("data-active", active);
      button?.setAttribute("aria-selected", String(active));
      if (active) tab.onShow?.();
      else if (tab.id === this.#active) tab.onHide?.();
    }
    this.#active = id;
  }
}

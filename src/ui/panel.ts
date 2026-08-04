import { el } from "./dom.ts";

export interface Panel {
  root: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
}

export function panel(title: string): Panel {
  const actions = el("div", { class: "controls" });
  const body = el("div", { class: "body" });
  const root = el("section", { class: "panel" }, [
    el("header", {}, [el("h2", { text: title }), actions]),
    body,
  ]);
  return { root, body, actions };
}

export function statusPill(text: string, state: "idle" | "busy" | "ok" | "error" = "idle") {
  const node = el("span", { class: "pill", text });
  node.dataset.state = state;
  return {
    node,
    set(nextText: string, nextState: typeof state) {
      node.textContent = nextText;
      node.dataset.state = nextState;
    },
  };
}

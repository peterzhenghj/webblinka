import { el } from "../dom.ts";
import { panel } from "../panel.ts";

const MAX_LINES = 400;

/** Python stdout/stderr plus our own progress notes, in arrival order. */
export class LogPanel {
  readonly root: HTMLElement;
  readonly #pre: HTMLElement;

  constructor() {
    const p = panel("Log");
    this.root = p.root;
    this.#pre = el("pre", { class: "log" });
    p.body.append(this.#pre);

    const clear = el("button", { text: "Clear" });
    clear.addEventListener("click", () => this.#pre.replaceChildren());
    p.actions.append(clear);
  }

  write(text: string, stream: "stdout" | "stderr" = "stdout"): void {
    const atBottom =
      this.#pre.scrollTop + this.#pre.clientHeight >= this.#pre.scrollHeight - 4;

    this.#pre.append(el("span", { class: stream, text: text.endsWith("\n") ? text : `${text}\n` }));
    while (this.#pre.childElementCount > MAX_LINES) this.#pre.firstElementChild?.remove();

    // Only follow the tail if the reader had not scrolled up to look at something.
    if (atBottom) this.#pre.scrollTop = this.#pre.scrollHeight;
  }
}

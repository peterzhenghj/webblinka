import { el } from "../dom.ts";
import { panel } from "../panel.ts";

export interface BoardInfo {
  chip: string;
  board: string;
  pins: string[];
}

export interface RuntimeInfo {
  python: string;
  blinka: string;
  connected: boolean;
}

/** What Blinka thinks it is running on, once the HID device is open. */
export class BoardPanel {
  readonly root: HTMLElement;
  readonly #body: HTMLElement;

  constructor() {
    const p = panel("Board");
    this.root = p.root;
    this.#body = p.body;
    this.#body.append(
      el("p", { class: "hint", text: "Connect an MCP2221 to bring Blinka up." }),
    );
  }

  show(board: BoardInfo, runtime: RuntimeInfo): void {
    this.#body.replaceChildren(
      el("dl", { class: "facts" }, [
        el("dt", { text: "Chip" }),
        el("dd", { text: board.chip }),
        el("dt", { text: "Board" }),
        el("dd", { text: board.board }),
        el("dt", { text: "GPIO" }),
        el("dd", { text: board.pins.join(", ") || "none" }),
        el("dt", { text: "Blinka" }),
        el("dd", { text: runtime.blinka }),
        el("dt", { text: "Python" }),
        el("dd", { text: runtime.python }),
      ]),
    );
  }
}

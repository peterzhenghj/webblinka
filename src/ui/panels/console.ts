import { el } from "../dom.ts";
import { panel } from "../panel.ts";

export interface ConsoleResult {
  output: string;
  result: string | null;
  error: string | null;
}

export interface ConsoleHandlers {
  exec(source: string): Promise<ConsoleResult>;
  reset(): Promise<string[]>;
  install(spec: string): Promise<{ requested: string; installed: string[] }>;
}

const PLACEHOLDER = `i2c.scan()`;

/**
 * The escape hatch: any CircuitPython library from PyPI, driven from a REPL
 * with the live bus in scope. This is what makes the site useful for parts
 * webblinka does not ship a panel for.
 */
export class ConsolePanel {
  readonly root: HTMLElement;
  readonly #input: HTMLTextAreaElement;
  readonly #transcript: HTMLElement;
  readonly #install: HTMLInputElement;
  readonly #installButton: HTMLButtonElement;
  readonly #run: HTMLButtonElement;
  readonly #handlers: ConsoleHandlers;

  constructor(handlers: ConsoleHandlers) {
    this.#handlers = handlers;
    const p = panel("Python");
    this.root = p.root;

    this.#run = el("button", { class: "primary", text: "Run", disabled: true });
    this.#run.addEventListener("click", () => void this.#exec());
    p.actions.append(this.#run);

    this.#input = el("textarea", {
      class: "console-input",
      rows: 3,
      spellcheck: false,
      placeholder: PLACEHOLDER,
      disabled: true,
    });
    // Enter runs; Shift+Enter is a newline, which is the convention people
    // already have in their fingers from notebooks.
    this.#input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.#exec();
      }
    });

    this.#install = el("input", {
      type: "text",
      class: "console-install",
      placeholder: "adafruit-circuitpython-bme280",
      disabled: true,
    });
    this.#installButton = el("button", { text: "Install from PyPI", disabled: true });
    this.#installButton.addEventListener("click", () => void this.#installPackage());

    this.#transcript = el("pre", { class: "log" });

    p.body.append(
      el("p", {
        class: "hint",
        text:
          "board, busio, digitalio, analogio and the live i2c bus are already " +
          "in scope. Enter runs, Shift+Enter adds a line.",
      }),
      this.#input,
      this.#transcript,
      el("div", { class: "controls console-pypi" }, [this.#install, this.#installButton]),
    );
  }

  async enable(): Promise<void> {
    this.#run.disabled = false;
    this.#input.disabled = false;
    this.#install.disabled = false;
    this.#installButton.disabled = false;
    const names = await this.#handlers.reset();
    this.#write(`# ready — ${names.join(", ")}`, "hint");
  }

  async #exec(): Promise<void> {
    const source = this.#input.value.trim();
    if (!source) return;
    this.#run.disabled = true;
    this.#write(`>>> ${source.replace(/\n/g, "\n... ")}`, "prompt");
    try {
      const { output, result, error } = await this.#handlers.exec(source);
      if (output) this.#write(output.replace(/\n$/, ""));
      if (error) this.#write(error.replace(/\n$/, ""), "stderr");
      if (result !== null) this.#write(result);
      if (!error) this.#input.value = "";
    } catch (err) {
      this.#write(err instanceof Error ? err.message : String(err), "stderr");
    } finally {
      this.#run.disabled = false;
      this.#input.focus();
    }
  }

  async #installPackage(): Promise<void> {
    const spec = this.#install.value.trim();
    if (!spec) return;
    const button = this.#installButton;
    button.disabled = true;
    this.#write(`# installing ${spec} from PyPI…`, "hint");
    try {
      const { installed } = await this.#handlers.install(spec);
      this.#write(`# installed ${installed.join(", ") || spec}`, "hint");
      this.#install.value = "";
    } catch (err) {
      this.#write(err instanceof Error ? err.message : String(err), "stderr");
    } finally {
      button.disabled = false;
    }
  }

  #write(text: string, kind: "stdout" | "stderr" | "prompt" | "hint" = "stdout"): void {
    this.#transcript.append(el("span", { class: kind, text: `${text}\n` }));
    this.#transcript.scrollTop = this.#transcript.scrollHeight;
  }
}

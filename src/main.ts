import "./ui/styles.css";
import { mount } from "./ui/app.ts";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("missing #app");
mount(root);

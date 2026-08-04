type Child = Node | string | null | undefined | false;

type Props<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], "children" | "style" | "dataset">
> & {
  class?: string;
  text?: string;
  dataset?: Record<string, string>;
};

/** Small hand-rolled element helper -- the site has no framework by design. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value as string;
    else if (key === "text") node.textContent = value as string;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else Object.assign(node, { [key]: value });
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/** 0x1f, padded and lowercase, the way i2cdetect prints addresses. */
export function hex(value: number, width = 2): string {
  return `0x${value.toString(16).padStart(width, "0")}`;
}

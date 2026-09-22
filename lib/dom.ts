/** Tiny DOM helpers. Enough to build panels without a framework. */
type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'children'>> & { class?: string; style?: string; dataset?: Record<string, string> } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'style') node.setAttribute('style', String(v));
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') (node as any)[k] = v;
    else if (k in node) (node as any)[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
};

export function clear(node: HTMLElement): HTMLElement {
  node.replaceChildren();
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A 24-viewBox icon drawn from one path. `filled` paints the middle in as well as the outline, so the same
 * path carries two states: an empty shape for "you could", a solid one for "you have".
 */
export function icon(path: string, filled = false, size = 15): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const d = document.createElementNS(SVG_NS, 'path');
  d.setAttribute('d', path);
  d.setAttribute('fill', filled ? 'currentColor' : 'none');
  d.setAttribute('stroke', 'currentColor');
  d.setAttribute('stroke-width', '1.8');
  d.setAttribute('stroke-linejoin', 'round');
  svg.append(d);
  return svg;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
export const fmtTime = (ts: number) => {
  const d = new Date(ts); const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
};

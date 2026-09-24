import type { Message } from './llm/types';

/**
 * A canvas is a list of shapes, never code: strokes, boxes, ellipses, lines, arrows, and text on an 800×500
 * sheet. The user draws them with the pointer; the model edits them by returning the whole list as JSON, which
 * is validated shape by shape before anything is drawn. Strokes are sent to the model by id and bounding box
 * rather than point by point, and come back by id, so a hundred-point scribble costs the prompt one line.
 */
export const CANVAS_W = 800;
export const CANVAS_H = 500;

interface Base { id: string; color: string; width?: number; opacity?: number }
export interface PathShape extends Base { type: 'path'; points: number[] }
export interface RectShape extends Base { type: 'rect'; x: number; y: number; w: number; h: number; fill?: boolean }
export interface EllipseShape extends Base { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number; fill?: boolean }
export interface LineShape extends Base { type: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number }
export interface TextShape extends Base { type: 'text'; x: number; y: number; text: string; size: number }
export type Shape = PathShape | RectShape | EllipseShape | LineShape | TextShape;

export const COLORS: Array<{ name: string; value: string }> = [
  { name: 'Ink', value: '#1f1a17' }, { name: 'Red', value: '#d7263d' }, { name: 'Orange', value: '#f07b1a' }, { name: 'Yellow', value: '#f2c230' },
  { name: 'Green', value: '#2f9e5b' }, { name: 'Blue', value: '#2b6fd6' }, { name: 'Purple', value: '#7d4fd1' }, { name: 'White', value: '#ffffff' },
];

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

export const newId = () => Math.random().toString(36).slice(2, 8);
const r1 = (n: number) => Math.round(n * 10) / 10;

export function pathD(points: number[]): string {
  if (points.length < 2) return '';
  let d = `M${r1(points[0]!)} ${r1(points[1]!)}`;
  for (let i = 2; i + 1 < points.length; i += 2) d += ` L${r1(points[i]!)} ${r1(points[i + 1]!)}`;
  if (points.length === 2) d += ` L${r1(points[0]! + 0.1)} ${r1(points[1]!)}`; // a dot
  return d;
}

/** One shape as SVG. Every node carries data-id so the eraser can find its shape. */
export function renderShape(s: Shape): SVGElement {
  const common = { 'data-id': s.id, stroke: s.color, 'stroke-width': s.width ?? 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none', opacity: s.opacity ?? 1 } as Record<string, string | number>;
  switch (s.type) {
    case 'path': return svgEl('path', { ...common, d: pathD(s.points) });
    case 'rect': return svgEl('rect', { ...common, x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), width: Math.abs(s.w), height: Math.abs(s.h), rx: 2, fill: s.fill ? s.color : 'none', 'fill-opacity': s.fill ? 0.25 : 0 });
    case 'ellipse': return svgEl('ellipse', { ...common, cx: s.cx, cy: s.cy, rx: Math.abs(s.rx), ry: Math.abs(s.ry), fill: s.fill ? s.color : 'none', 'fill-opacity': s.fill ? 0.25 : 0 });
    case 'line': return svgEl('line', { ...common, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 });
    case 'arrow': {
      const g = svgEl('g', { 'data-id': s.id, opacity: s.opacity ?? 1 });
      const w = s.width ?? 3;
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const head = 8 + w * 2.2;
      const bx = s.x2 - Math.cos(angle) * head * 0.8; const by = s.y2 - Math.sin(angle) * head * 0.8;
      g.append(svgEl('line', { ...common, 'data-id': s.id, x1: s.x1, y1: s.y1, x2: bx, y2: by }));
      const tip = [[s.x2, s.y2], [s.x2 - Math.cos(angle - 0.45) * head, s.y2 - Math.sin(angle - 0.45) * head], [s.x2 - Math.cos(angle + 0.45) * head, s.y2 - Math.sin(angle + 0.45) * head]];
      g.append(svgEl('polygon', { 'data-id': s.id, points: tip.map(([x, y]) => `${r1(x!)},${r1(y!)}`).join(' '), fill: s.color, stroke: s.color, 'stroke-width': 1, 'stroke-linejoin': 'round' }));
      return g;
    }
    case 'text': {
      const t = svgEl('text', { 'data-id': s.id, x: s.x, y: s.y, fill: s.color, 'font-size': s.size, 'font-family': 'ui-sans-serif, system-ui, sans-serif', opacity: s.opacity ?? 1 });
      const lines = s.text.split('\n');
      lines.forEach((line, i) => { const span = svgEl('tspan', { x: s.x, dy: i === 0 ? 0 : s.size * 1.25 }); span.textContent = line; t.append(span); });
      return t;
    }
  }
}

export function bbox(s: Shape): [number, number, number, number] {
  switch (s.type) {
    case 'path': {
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (let i = 0; i + 1 < s.points.length; i += 2) { x0 = Math.min(x0, s.points[i]!); x1 = Math.max(x1, s.points[i]!); y0 = Math.min(y0, s.points[i + 1]!); y1 = Math.max(y1, s.points[i + 1]!); }
      return Number.isFinite(x0) ? [x0, y0, x1 - x0, y1 - y0] : [0, 0, 0, 0];
    }
    case 'rect': return [Math.min(s.x, s.x + s.w), Math.min(s.y, s.y + s.h), Math.abs(s.w), Math.abs(s.h)];
    case 'ellipse': return [s.cx - Math.abs(s.rx), s.cy - Math.abs(s.ry), Math.abs(s.rx) * 2, Math.abs(s.ry) * 2];
    case 'line': case 'arrow': return [Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1)];
    case 'text': return [s.x, s.y - s.size, s.text.length * s.size * 0.55, s.size * 1.3 * s.text.split('\n').length];
  }
}

// ---------- the model's view ----------

const R = (n: number) => Math.round(n);

/** The scene as the model sees it: everything but the points of strokes, which are described by their box. */
export function sceneForModel(shapes: Shape[]): string {
  return JSON.stringify(shapes.map((s) => {
    if (s.type === 'path') { const [x, y, w, h] = bbox(s); return { type: 'path', id: s.id, color: s.color, box: [R(x), R(y), R(w), R(h)], note: 'a freehand stroke; keep it by id or drop it' }; }
    const o: Record<string, unknown> = { ...s };
    for (const k of Object.keys(o)) if (typeof o[k] === 'number') o[k] = R(o[k] as number);
    return o;
  }));
}

export const CANVAS_SYSTEM = `You edit a drawing. The drawing is a JSON list of shapes on a canvas ${CANVAS_W} wide and ${CANVAS_H} tall, origin top-left, y growing downwards.
Shape kinds, all with "color" (a CSS hex like #2b6fd6) and optional "width" (stroke, 1 to 12):
{"type":"rect","x","y","w","h","fill":true|false}
{"type":"ellipse","cx","cy","rx","ry","fill":true|false}
{"type":"line","x1","y1","x2","y2"}
{"type":"arrow","x1","y1","x2","y2"}  (the head is at x2,y2)
{"type":"text","x","y","text","size"}  (x,y is the baseline start; size 12 to 64)
{"type":"path","id":"…"}  (an existing freehand stroke, referenced by its id; you cannot create new paths)
Reply with ONLY a JSON object {"shapes":[…]} holding the complete new list: keep what should stay, change what should change, leave out what should go. No prose, no code fences.`;

export function canvasMessages(shapes: Shape[], instruction: string): Message[] {
  return [
    { role: 'system', content: CANVAS_SYSTEM },
    { role: 'user', content: `Current shapes:\n${sceneForModel(shapes)}\n\nInstruction: ${instruction}` },
  ];
}

const num = (v: unknown, lo: number, hi: number): number | null => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null; };
const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim()) || (typeof v === 'string' && /^[a-z]{3,20}$/i.test(v) && CSS.supports('color', v));

/** One shape from the model, or null. Paths only come back by id. */
export function validateShape(raw: unknown, existing: Map<string, Shape>): Shape | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const color = isColor(o.color) ? String(o.color).trim() : COLORS[0]!.value;
  const width = num(o.width, 1, 12) ?? undefined;
  const id = typeof o.id === 'string' && o.id ? o.id.slice(0, 12) : newId();
  const X = (v: unknown) => num(v, -CANVAS_W, CANVAS_W * 2); const Y = (v: unknown) => num(v, -CANVAS_H, CANVAS_H * 2);
  switch (o.type) {
    case 'path': { const prev = existing.get(id); return prev && prev.type === 'path' ? { ...prev, color: isColor(o.color) ? color : prev.color } : null; }
    case 'rect': { const x = X(o.x), y = Y(o.y), w = X(o.w), h = Y(o.h); return x === null || y === null || w === null || h === null ? null : { type: 'rect', id, color, width, x, y, w, h, fill: !!o.fill }; }
    case 'ellipse': { const cx = X(o.cx), cy = Y(o.cy), rx = num(o.rx, 0, CANVAS_W), ry = num(o.ry, 0, CANVAS_H); return cx === null || cy === null || rx === null || ry === null ? null : { type: 'ellipse', id, color, width, cx, cy, rx, ry, fill: !!o.fill }; }
    case 'line': case 'arrow': { const x1 = X(o.x1), y1 = Y(o.y1), x2 = X(o.x2), y2 = Y(o.y2); return x1 === null || y1 === null || x2 === null || y2 === null ? null : { type: o.type, id, color, width, x1, y1, x2, y2 }; }
    case 'text': { const x = X(o.x), y = Y(o.y); const text = typeof o.text === 'string' ? o.text.slice(0, 400) : ''; return x === null || y === null || !text.trim() ? null : { type: 'text', id, color, x, y, text, size: num(o.size, 10, 96) ?? 20 }; }
    default: return null;
  }
}

/** The model's reply as shapes: finds the JSON in it, forgives fences and trailing commas, validates each shape. Null when nothing usable. */
export function parseShapesReply(text: string, existing: Shape[]): Shape[] | null {
  const byId = new Map(existing.map((s) => [s.id, s]));
  let body = text.replace(/```(?:json)?/gi, '').trim();
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  body = body.slice(start);
  const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
  if (end < 0) return null;
  body = body.slice(0, end + 1);
  const attempts = [body, body.replace(/,(\s*[}\]])/g, '$1')];
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.shapes) ? parsed.shapes : null;
      if (!list) continue;
      const shapes = (list as unknown[]).map((s) => validateShape(s, byId)).filter((s): s is Shape => s !== null);
      return shapes.slice(0, 400);
    } catch { /* try the next repair */ }
  }
  return null;
}

// ---------- export ----------

/** The drawing as a PNG at twice the canvas size, on a solid background so it reads on any wall. */
export async function exportPng(shapes: Shape[], background: string): Promise<Blob> {
  const svg = svgEl('svg', { xmlns: SVG_NS, viewBox: `0 0 ${CANVAS_W} ${CANVAS_H}`, width: CANVAS_W * 2, height: CANVAS_H * 2 });
  svg.append(svgEl('rect', { x: 0, y: 0, width: CANVAS_W, height: CANVAS_H, fill: background }));
  for (const s of shapes) svg.append(renderShape(s));
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('Could not render the drawing.')); img.src = url; });
    const canvas = document.createElement('canvas'); canvas.width = CANVAS_W * 2; canvas.height = CANVAS_H * 2;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the PNG.'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

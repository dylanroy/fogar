import type { WidgetInstance } from '@/lib/layout';
import { clear, el } from '@/lib/dom';
import { getItem, setItem } from '@/lib/store';
import { choices, loadProfiles, providerFor, type ChoiceId } from '@/lib/chat-models';
import { CANVAS_H, CANVAS_W, COLORS, canvasMessages, exportPng, newId, parseShapesReply, renderShape, validateShape, type PathShape, type Shape } from '@/lib/canvas-scene';
import { cacheKey, field, setupForm, type WidgetCtx, type WidgetDef } from './shared';

/**
 * Canvas: a whiteboard. Draw with the pointer the way you annotate a shared screen: pen, highlighter, arrows,
 * boxes, ellipses, text, an eraser. Or tell the model what to draw or change; it answers with the shapes as
 * data, which are checked and drawn. Everything is a list of shapes in extension storage; a PNG is one click.
 */
type Tool = 'pen' | 'highlighter' | 'arrow' | 'line' | 'rect' | 'ellipse' | 'text' | 'eraser';
const TOOLS: Array<{ id: Tool; label: string; icon: string }> = [
  { id: 'pen', label: 'Pen', icon: '✎' }, { id: 'highlighter', label: 'Highlighter', icon: '▮' }, { id: 'arrow', label: 'Arrow', icon: '➚' }, { id: 'line', label: 'Line', icon: '╲' },
  { id: 'rect', label: 'Box', icon: '▭' }, { id: 'ellipse', label: 'Ellipse', icon: '◯' }, { id: 'text', label: 'Text', icon: 'T' }, { id: 'eraser', label: 'Eraser', icon: '⌫' },
];
const PAPER = '#fbf7ef';
const SVG_NS = 'http://www.w3.org/2000/svg';
interface CanvasData { shapes: Shape[] }

export const canvas: WidgetDef = {
  type: 'canvas', title: 'Canvas', description: 'A whiteboard: draw, annotate, or tell the model what to draw.', single: false, wide: true, fill: true,
  defaultConfig: () => ({ name: 'Canvas', model: 'auto' }),
  name: (inst) => inst.config.name || 'Canvas',
  async render(body, actions, inst, ctx) {
    const { app } = ctx;
    const saved = await getItem<CanvasData | null>(cacheKey(inst), null);
    // Saved strokes carry their points (the model only ever refers to strokes by id, so validateShape does not take points).
    const restore = (raw: any): Shape | null => {
      if (raw?.type === 'path' && Array.isArray(raw.points)) return { type: 'path', id: String(raw.id || newId()), color: String(raw.color ?? COLORS[0]!.value), width: Number(raw.width) || 3, opacity: Number(raw.opacity) || 1, points: raw.points.map(Number).filter(Number.isFinite) };
      return validateShape(raw, new Map());
    };
    let shapes: Shape[] = Array.isArray(saved?.shapes) ? (saved!.shapes as unknown[]).map(restore).filter((s): s is Shape => !!s) : [];
    // Saves happen on commits (a stroke ending, an undo, a reply from the model), never per pointer move, so they need no debounce.
    const save = () => void setItem(cacheKey(inst), { shapes });

    let tool: Tool = 'pen'; let color = COLORS[0]!.value; let width = 3;
    const undoStack: string[] = []; const redoStack: string[] = [];
    const snapshot = () => { undoStack.push(JSON.stringify(shapes)); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; paintHistory(); };

    // ---- surface ----
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'cv-surface'); svg.setAttribute('viewBox', `0 0 ${CANVAS_W} ${CANVAS_H}`); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const sheet = document.createElementNS(SVG_NS, 'rect');
    sheet.setAttribute('x', '0'); sheet.setAttribute('y', '0'); sheet.setAttribute('width', String(CANVAS_W)); sheet.setAttribute('height', String(CANVAS_H)); sheet.setAttribute('fill', PAPER); sheet.setAttribute('rx', '6');
    const layer = document.createElementNS(SVG_NS, 'g');
    svg.append(sheet, layer);
    const stage = el('div', { class: 'cv-stage' });
    const textbox = el('input', { class: 'cv-textbox line-input', type: 'text', hidden: true, placeholder: 'Type, then Enter' });
    stage.append(svg, textbox);
    const paint = () => { clear(layer as unknown as HTMLElement); for (const s of shapes) layer.append(renderShape(s)); };
    const toPoint = (e: PointerEvent | MouseEvent): { x: number; y: number } => {
      const ctm = svg.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      return { x: Math.max(0, Math.min(CANVAS_W, p.x)), y: Math.max(0, Math.min(CANVAS_H, p.y)) };
    };

    // ---- toolbar ----
    const toolBtns = new Map<Tool, HTMLButtonElement>();
    const tools = el('div', { class: 'cv-tools', role: 'toolbar' });
    for (const t of TOOLS) {
      const b = el('button', { class: 'cv-tool', type: 'button', title: t.label, 'aria-label': t.label, 'aria-pressed': String(t.id === tool), dataset: { tool: t.id }, onclick: () => setTool(t.id) } as any, t.icon);
      toolBtns.set(t.id, b); tools.append(b);
    }
    const setTool = (t: Tool) => { tool = t; for (const [id, b] of toolBtns) b.setAttribute('aria-pressed', String(id === t)); svg.dataset.tool = t; };
    const swatches = el('div', { class: 'cv-colors', role: 'group', 'aria-label': 'Colour' } as any);
    const paintSwatches = () => { for (const s of swatches.querySelectorAll<HTMLElement>('.cv-color')) s.setAttribute('aria-pressed', String(s.dataset.color === color)); };
    for (const c of COLORS) swatches.append(el('button', { class: 'cv-color', type: 'button', title: c.name, 'aria-label': c.name, dataset: { color: c.value }, style: `--sw:${c.value}`, onclick: () => { color = c.value; paintSwatches(); } } as any));
    paintSwatches();
    const size = el('select', { class: 'cv-size', title: 'Stroke width' });
    for (const [v, label] of [[2, 'Thin'], [3, 'Normal'], [6, 'Thick'], [10, 'Marker']] as Array<[number, string]>) size.append(new Option(label, String(v), false, v === width));
    size.onchange = () => { width = Number(size.value); };
    const undoBtn = el('button', { class: 'ctl', type: 'button', title: 'Undo', onclick: () => { const prev = undoStack.pop(); if (prev === undefined) return; redoStack.push(JSON.stringify(shapes)); shapes = JSON.parse(prev); paint(); save(); paintHistory(); } }, '↶');
    const redoBtn = el('button', { class: 'ctl', type: 'button', title: 'Redo', onclick: () => { const next = redoStack.pop(); if (next === undefined) return; undoStack.push(JSON.stringify(shapes)); shapes = JSON.parse(next); paint(); save(); paintHistory(); } }, '↷');
    const paintHistory = () => { undoBtn.disabled = !undoStack.length; redoBtn.disabled = !redoStack.length; };
    const clearBtn = el('button', { class: 'ghost small', type: 'button', onclick: () => { if (!shapes.length) return; snapshot(); shapes = []; paint(); save(); } }, 'Clear');
    const pngBtn = el('button', { class: 'ghost small cv-png', type: 'button', onclick: async () => {
      try {
        const blob = await exportPng(shapes, PAPER);
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${(inst.config.name || 'canvas').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) { app.toast((err as Error).message); }
    } }, 'Save PNG');
    paintHistory();

    // ---- drawing ----
    let active: { shape: Shape; node: SVGElement; start: { x: number; y: number } } | null = null;
    const commitText = () => {
      const v = textbox.value.trim(); const x = Number(textbox.dataset.x); const y = Number(textbox.dataset.y);
      textbox.hidden = true; textbox.value = '';
      if (!v) return;
      snapshot(); shapes.push({ type: 'text', id: newId(), color, x, y, text: v, size: 14 + width * 3 }); paint(); save();
    };
    textbox.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitText(); } if (e.key === 'Escape') { textbox.hidden = true; textbox.value = ''; } });
    textbox.addEventListener('blur', () => { if (!textbox.hidden) commitText(); });
    const eraseAt = (e: PointerEvent) => {
      const under = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
      const id = under?.closest<SVGElement>('[data-id]')?.dataset.id;
      if (!id || !svg.contains(under)) return;
      if (!active) { snapshot(); active = { shape: shapes[0]!, node: layer, start: { x: 0, y: 0 } }; } // one undo step per erasing gesture
      shapes = shapes.filter((s) => s.id !== id); paint();
    };
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); svg.setPointerCapture(e.pointerId);
      const p = toPoint(e);
      if (tool === 'text') {
        if (!textbox.hidden) commitText();
        const r = stage.getBoundingClientRect(); const sr = svg.getBoundingClientRect();
        textbox.hidden = false; textbox.dataset.x = String(Math.round(p.x)); textbox.dataset.y = String(Math.round(p.y));
        textbox.style.left = `${e.clientX - r.left}px`; textbox.style.top = `${e.clientY - r.top}px`; textbox.style.fontSize = `${Math.max(12, (14 + width * 3) * (sr.width / CANVAS_W))}px`;
        textbox.focus();
        return;
      }
      if (tool === 'eraser') { eraseAt(e); return; }
      const id = newId();
      let shape: Shape;
      if (tool === 'pen' || tool === 'highlighter') shape = { type: 'path', id, color: tool === 'highlighter' ? (color === COLORS[0]!.value ? '#f2c230' : color) : color, width: tool === 'highlighter' ? width * 5 : width, opacity: tool === 'highlighter' ? 0.4 : 1, points: [p.x, p.y] };
      else if (tool === 'rect') shape = { type: 'rect', id, color, width, x: p.x, y: p.y, w: 0, h: 0 };
      else if (tool === 'ellipse') shape = { type: 'ellipse', id, color, width, cx: p.x, cy: p.y, rx: 0, ry: 0 };
      else shape = { type: tool, id, color, width, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      const node = renderShape(shape); layer.append(node);
      active = { shape, node, start: p };
    });
    svg.addEventListener('pointermove', (e) => {
      if (tool === 'eraser') { if (e.buttons & 1) eraseAt(e); return; }
      if (!active) return;
      const p = toPoint(e); const s = active.shape; const st = active.start;
      if (s.type === 'path') { const pts = (s as PathShape).points; const lx = pts[pts.length - 2]!; const ly = pts[pts.length - 1]!; if (Math.hypot(p.x - lx, p.y - ly) >= 1.2) pts.push(p.x, p.y); }
      else if (s.type === 'rect') { s.x = Math.min(st.x, p.x); s.y = Math.min(st.y, p.y); s.w = Math.abs(p.x - st.x); s.h = Math.abs(p.y - st.y); }
      else if (s.type === 'ellipse') { s.cx = (st.x + p.x) / 2; s.cy = (st.y + p.y) / 2; s.rx = Math.abs(p.x - st.x) / 2; s.ry = Math.abs(p.y - st.y) / 2; }
      else if (s.type === 'line' || s.type === 'arrow') { s.x2 = p.x; s.y2 = p.y; }
      const fresh = renderShape(s); active.node.replaceWith(fresh); active.node = fresh;
    });
    const finish = () => {
      if (!active) return;
      const s = active.shape;
      if (tool === 'eraser') { active = null; save(); paintHistory(); return; }
      const tiny = (s.type === 'rect' && s.w < 2 && s.h < 2) || (s.type === 'ellipse' && s.rx < 1 && s.ry < 1) || ((s.type === 'line' || s.type === 'arrow') && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 2);
      active.node.remove(); active = null;
      if (tiny) return;
      if (s.type === 'path') { const pts = s.points; for (let i = 0; i < pts.length; i++) pts[i] = Math.round(pts[i]! * 10) / 10; }
      snapshot(); shapes.push(s); paint(); save();
    };
    svg.addEventListener('pointerup', finish); svg.addEventListener('pointercancel', finish);

    // ---- ask the model ----
    let profiles = await loadProfiles();
    const modelPick = el('select', { class: 'line-input cv-model', title: 'Which model draws' });
    const paintModels = () => {
      clear(modelPick);
      modelPick.append(new Option(`Fogar’s current model (${app.settings.mode === 'cloud' ? app.settings.cloud.model : 'this device'})`, 'auto', false, (inst.config.model ?? 'auto') === 'auto'));
      for (const c of choices(app, profiles)) if (c.ready) modelPick.append(new Option(c.name, c.id, false, c.id === inst.config.model));
    };
    paintModels();
    modelPick.onchange = async () => { inst.config.model = modelPick.value; await ctx.save(inst); };
    const askInput = el('input', { class: 'line-input cv-ask', type: 'text', placeholder: 'Tell the model what to draw or change, e.g. "add a red arrow from the box to the circle"', autocomplete: 'off' });
    const askStatus = el('span', { class: 'muted cv-status' });
    const askBtn = el('button', { class: 'primary small cv-go', type: 'button' }, 'Draw');
    let asking: AbortController | null = null;
    const askModel = async () => {
      const instruction = askInput.value.trim(); if (!instruction || asking) return;
      const id: ChoiceId = (inst.config.model as string) || 'auto';
      let provider = id === 'auto' ? null : providerFor(id, app, profiles);
      if (id === 'auto') {
        if (!app.isReady() && !(await app.ensureModel())) { app.toast('No model is ready. Load one in Settings or pick a model here.'); return; }
        if (app.isBusy()) { app.toast('The model is busy with the ask bar. Wait a moment.'); return; }
        provider = app.provider();
      }
      if (!provider) { app.toast('That model is not set up.'); return; }
      asking = new AbortController(); askBtn.disabled = true; askStatus.textContent = 'Drawing…';
      let text = '';
      try {
        for await (const tok of provider.ask(canvasMessages(shapes, instruction), asking.signal, { maxTokens: 1500, temperature: 0.2 })) text += tok;
        const next = parseShapesReply(text, shapes);
        if (!next) { askStatus.textContent = 'The model did not answer with shapes. A larger model (the 4B, or a cloud one) follows the format; try again or rephrase.'; console.warn('[fogar] canvas: unparsable reply', text.slice(0, 400)); return; }
        snapshot(); shapes = next; paint(); save();
        askInput.value = ''; askStatus.textContent = `${next.length} shape${next.length === 1 ? '' : 's'} on the canvas.`;
      } catch (err) {
        askStatus.textContent = asking.signal.aborted ? 'Stopped.' : (err as Error).message;
      } finally {
        asking = null; askBtn.disabled = false;
      }
    };
    askBtn.onclick = () => void askModel();
    askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void askModel(); } });
    app.onReadyChange(() => { if (modelPick.isConnected) paintModels(); });
    document.addEventListener('visibilitychange', async () => { if (!document.hidden && modelPick.isConnected) { profiles = await loadProfiles(); paintModels(); } });

    actions.append(pngBtn);
    body.append(
      el('div', { class: 'cv' },
        el('div', { class: 'cv-bar' }, tools, swatches, size, el('span', { class: 'cv-history' }, undoBtn, redoBtn), clearBtn),
        stage,
        el('div', { class: 'cv-chat' }, askInput, modelPick, askBtn), askStatus),
    );
    setTool('pen'); paint();
  },
  configure(body, inst, ctx) {
    const name = el('input', { class: 'line-input', type: 'text', value: inst.config.name ?? 'Canvas' });
    clear(body);
    body.append(
      el('p', { class: 'muted' }, 'Drawings are lists of shapes kept in this browser. When you ask the model to draw, it gets the shapes as text and answers with a new list, which is checked before anything is drawn; your own strokes travel by id, never point by point.'),
      setupForm([field('Title', name)], async () => { inst.config.name = name.value.trim() || 'Canvas'; await ctx.save(inst); ctx.remount(inst); }, () => ctx.remount(inst)),
    );
  },
};

import type { App } from '../app';
import { $, clear, el } from '@/lib/dom';
import { applyLayoutAttrs, loadLayout, newInstance, saveLayout, type Layout, type WidgetInstance, type WidgetType } from '@/lib/layout';
import type { RecipesUI } from '../ui/recipes';
import type { TodosUI } from '../ui/todos';
import type { RemindersUI } from '../ui/reminders';
import { WIDGETS, widgetDef, type WidgetCtx } from './defs';

export interface WidgetsUI {
  layout: Layout;
  ensure(type: WidgetType): Promise<void>;
  /** Change the page shape (ask placement, arrangement, columns, recipes row, focus); persists and repaints. */
  update(patch: Partial<Pick<Layout, 'ask' | 'arrangement' | 'columns' | 'showRecipes' | 'focus'>>): Promise<void>;
}

/** Renders the layout, owns the controls (reorder, configure, hide, add), and the Focus toggle. */
export async function initWidgets(app: App, deps: { recipes: RecipesUI; todos: TodosUI; reminders: RemindersUI }): Promise<WidgetsUI> {
  const grid = $('widgets');
  const layout = await loadLayout();
  const cards = new Map<string, HTMLElement>();
  applyLayoutAttrs(layout);

  const persist = () => saveLayout(layout);
  const ctx: WidgetCtx = {
    app, recipes: deps.recipes, todos: deps.todos, reminders: deps.reminders,
    save: async (inst) => { await persist(); },
    remount: (inst) => { const card = cards.get(inst.id); if (card) mountBody(card, inst); },
  };

  function mountBody(card: HTMLElement, inst: WidgetInstance) {
    const body = card.querySelector<HTMLElement>('.widget-body')!;
    const actions = card.querySelector<HTMLElement>('.widget-actions')!;
    clear(body);
    for (const extra of actions.querySelectorAll('.widget-extra')) extra.remove();
    const def = widgetDef(inst.type);
    card.querySelector('h2')!.textContent = def.name(inst);
    // Widget-provided header actions (e.g. "Clear done") go before the controls and carry a marker class.
    const proxy = el('span', { class: 'row-actions' });
    void Promise.resolve(def.render(body, proxy, inst, ctx)).catch((err) => { body.textContent = `This widget hit an error: ${(err as Error).message}`; });
    for (const node of Array.from(proxy.children)) { node.classList.add('widget-extra'); actions.prepend(node); }
  }

  const isWide = (inst: WidgetInstance): boolean => inst.config.wide ?? widgetDef(inst.type).wide ?? false;

  function buildCard(inst: WidgetInstance, index: number): HTMLElement {
    const def = widgetDef(inst.type);
    const ctrl = (label: string, title: string, onclick: () => void, disabled = false) =>
      el('button', { class: 'ctl', type: 'button', title, 'aria-label': title, disabled, onclick } as any, label);
    const controls = el('span', { class: 'widget-controls' },
      ctrl('↑', 'Move up', () => void move(inst, -1), index === 0),
      ctrl('↓', 'Move down', () => void move(inst, 1), index === layout.widgets.length - 1),
      def.configure ? ctrl('⚙', 'Settings', () => { const card = cards.get(inst.id)!; def.configure!(card.querySelector<HTMLElement>('.widget-body')!, inst, ctx); }) : null,
      ctrl(isWide(inst) ? '⤡' : '⤢', isWide(inst) ? 'Half width' : 'Full width', async () => { inst.config.wide = !isWide(inst); await persist(); render(); }),
      ctrl('×', 'Remove from page', () => void remove(inst)),
    );
    const title = el('h2', { draggable: true, title: 'Drag to reorder' }, def.name(inst));
    const card = el('div', { class: `card panel widget${isWide(inst) ? ' wide' : ''}`, dataset: { type: inst.type, id: inst.id } },
      el('div', { class: 'row-head' }, title, el('span', { class: 'row-actions widget-actions' }, controls)),
      el('div', { class: 'widget-body' }));
    if (inst.type === 'todos') card.id = 'todos-card';
    if (inst.type === 'reminders') card.id = 'reminders-card';

    // Drag the title to reorder. Dropping on the left/top half of a card lands before it, the right/bottom half after.
    title.addEventListener('dragstart', (e) => {
      dragId = inst.id; card.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', inst.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    title.addEventListener('dragend', () => { dragId = null; card.classList.remove('dragging'); clearDropMarks(); });
    const side = (e: DragEvent) => {
      const r = card.getBoundingClientRect();
      return isWide(inst) ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
    };
    card.addEventListener('dragover', (e) => {
      if (!dragId || dragId === inst.id) return;
      e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const before = side(e);
      card.classList.toggle('drop-before', before); card.classList.toggle('drop-after', !before);
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
    card.addEventListener('drop', (e) => {
      if (!dragId || dragId === inst.id) return;
      e.preventDefault();
      void reorder(dragId, inst.id, side(e));
    });
    return card;
  }

  let dragId: string | null = null;
  const clearDropMarks = () => { for (const c of cards.values()) c.classList.remove('drop-before', 'drop-after'); };
  async function reorder(fromId: string, toId: string, before: boolean) {
    const from = layout.widgets.findIndex((w) => w.id === fromId);
    if (from < 0) return;
    const [moved] = layout.widgets.splice(from, 1);
    let to = layout.widgets.findIndex((w) => w.id === toId);
    if (to < 0) { layout.widgets.splice(from, 0, moved!); return; }
    if (!before) to += 1;
    layout.widgets.splice(to, 0, moved!);
    await persist(); render();
  }

  function render() {
    clear(grid); cards.clear();
    layout.widgets.forEach((inst, i) => { const card = buildCard(inst, i); cards.set(inst.id, card); grid.append(card); mountBody(card, inst); });
    $('corner-empty').hidden = layout.widgets.length > 0;
    paintMenu();
  }

  async function move(inst: WidgetInstance, dir: -1 | 1) {
    const i = layout.widgets.indexOf(inst); const j = i + dir;
    if (i < 0 || j < 0 || j >= layout.widgets.length) return;
    [layout.widgets[i], layout.widgets[j]] = [layout.widgets[j]!, layout.widgets[i]!];
    await persist(); render();
  }
  async function remove(inst: WidgetInstance) {
    layout.widgets = layout.widgets.filter((w) => w !== inst);
    await persist(); render();
    app.toast(`${widgetDef(inst.type).name(inst)} removed. Add it back any time.`);
  }
  async function add(type: WidgetType) {
    const def = widgetDef(type);
    if (def.single && layout.widgets.some((w) => w.type === type)) return;
    const inst = type === 'todos' || type === 'reminders' ? { id: type, type, config: {} } : newInstance(type, def.defaultConfig());
    layout.widgets.push(inst);
    await persist(); render();
    menu.hidden = true; addBtn.setAttribute('aria-expanded', 'false');
    cards.get(inst.id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Add menu
  const addBtn = $('widget-add'); const menu = $('widget-menu');
  function paintMenu() {
    clear(menu);
    for (const def of WIDGETS) {
      const present = def.single && layout.widgets.some((w) => w.type === def.type);
      menu.append(el('button', { class: 'menu-item', type: 'button', role: 'menuitem', disabled: present, onclick: () => void add(def.type) } as any,
        el('strong', {}, def.title, present ? el('span', { class: 'muted' }, '  on the page') : ''), el('span', { class: 'muted' }, def.description)));
    }
  }
  addBtn.onclick = () => { menu.hidden = !menu.hidden; addBtn.setAttribute('aria-expanded', String(!menu.hidden)); };
  document.addEventListener('click', (e) => { if (!menu.contains(e.target as Node) && e.target !== addBtn) { menu.hidden = true; addBtn.setAttribute('aria-expanded', 'false'); } });

  // Focus mode
  const focusBtn = $('focus-toggle');
  const paintFocus = () => { applyLayoutAttrs(layout); focusBtn.textContent = layout.focus ? 'Show everything' : 'Focus'; focusBtn.setAttribute('aria-pressed', String(layout.focus)); };
  focusBtn.onclick = async () => { layout.focus = !layout.focus; await persist(); paintFocus(); };
  paintFocus();

  async function update(patch: Partial<Pick<Layout, 'ask' | 'arrangement' | 'columns' | 'showRecipes' | 'focus'>>) {
    Object.assign(layout, patch);
    await persist();
    paintFocus();
  }

  // The ask bar can capture "remind me…" even when the widget is hidden.
  deps.reminders.onNeedMount = () => add('reminders');

  render();
  return { layout, ensure: (type) => add(type), update };
}

import type { App } from '../app';
import { clear, el, icon } from '@/lib/dom';
import { addTodo, clearDone, loadTodos, moveTodo, removeTodo, toggleTodo, updateTodo, type Todo } from '@/lib/todos';

export interface TodosUI {
  /** Build the panel body into a host. Ids are stable so tests and other code can find them. */
  mount(body: HTMLElement, actions: HTMLElement): void;
  /** Add a todo from anywhere (the ask bar). Persists even when the widget is not on the page. */
  add(text: string): Promise<void>;
}

/** Six dots, the handle a todo is dragged by. Zero-length strokes; the stylesheet's round caps draw them as dots. */
const GRIP = 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01';
/** How far the pointer travels before a press on a row becomes a drag instead of a click. */
const DRAG_THRESHOLD = 4;
const swallow = (e: Event) => { e.stopPropagation(); e.preventDefault(); };

export function createTodosUI(app: App): TodosUI {
  let list: HTMLElement | null = null; let empty: HTMLElement | null = null; let clearBtn: HTMLElement | null = null;

  let current: Todo[] = [];

  /** Click the text to edit it in place. Enter saves, Escape cancels, and an emptied todo keeps its old text. */
  const startEdit = (row: HTMLElement, textEl: HTMLElement, t: Todo) => {
    const input = el('input', { class: 'line-input edit', type: 'text', value: t.text, 'aria-label': 'Edit todo' } as any);
    let finished = false;
    const finish = async (save: boolean) => {
      if (finished) return; finished = true;
      const next = input.value.trim();
      if (save && next && next !== t.text) render(await updateTodo(t.id, next));
      else render(current);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
    });
    input.addEventListener('blur', () => void finish(true));
    textEl.replaceWith(input);
    row.classList.add('editing');
    input.focus(); input.select();
  };

  const rowOf = (id: string) => list?.querySelector<HTMLElement>(`.item[data-id="${CSS.escape(id)}"]`) ?? null;

  /** The arrow keys on a todo's grip move it one place. Focus follows it into the repainted list, so the next press keeps it moving. */
  const nudge = async (t: Todo, dir: -1 | 1) => {
    const i = current.findIndex((x) => x.id === t.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= current.length) return;
    // One place up is in front of the todo above. One place down is in front of the todo after next, or the end.
    render(await moveTodo(t.id, dir < 0 ? current[j]!.id : current[j + 1]?.id ?? null));
    rowOf(t.id)?.querySelector<HTMLElement>('.grip')?.focus();
  };

  /** After a drop the list on screen is already in its new order. Repaint only if the saved order differs: another tab changed the list meanwhile. */
  const settle = (todos: Todo[]) => {
    const shown = list ? Array.from(list.children, (li) => (li as HTMLElement).dataset.id) : [];
    if (todos.length === shown.length && todos.every((t, i) => t.id === shown[i])) current = todos;
    else render(todos);
  };

  /**
   * Drag to reorder, by the grip or by any part of the row that is not a control. A press turns into a drag only
   * once the pointer has moved a few pixels, so a click still edits the text. The row follows the pointer inside
   * the list and the rows it passes slide out of its way. Letting go saves the order; Escape puts it back.
   */
  const drag = (e: PointerEvent, row: HTMLElement, t: Todo) => {
    const ul = list;
    const target = e.target as Element;
    if (!ul || e.button !== 0 || target.closest('input, button:not(.grip)')) return; // the checkbox, remove, the edit field
    if (ul.querySelector('.editing')) return; // this press saves the open edit, which repaints the list
    if (e.pointerType === 'touch' && !target.closest('.grip')) return; // a finger on the row scrolls the page
    const x0 = e.clientX; const y0 = e.clientY;
    const grab = y0 - row.getBoundingClientRect().top;
    const home = row.nextElementSibling;
    let live = false;

    // The rows it passes are the ones moved in the DOM, never the dragged row, so it keeps its pointer capture and
    // focus. Each starts from where it was drawn and glides to its new slot.
    const pass = (other: HTMLElement, move: () => void) => {
      const was = other.getBoundingClientRect().top;
      move();
      other.style.transition = 'none'; other.style.transform = '';
      other.style.transform = `translateY(${was - other.getBoundingClientRect().top}px)`;
      void other.offsetHeight; // commit the starting point before the transition comes back
      other.style.transition = ''; other.style.transform = '';
    };
    const follow = (y: number) => {
      // Where the row would be drawn, in the list's coordinates (the list is the rows' offsetParent). Slots are
      // compared by layout (offsetTop), never by where a gliding row happens to be drawn, so nothing flickers.
      const top = y - ul.getBoundingClientRect().top - grab;
      const mid = top + row.offsetHeight / 2;
      for (;;) {
        const prev = row.previousElementSibling as HTMLElement | null;
        const next = row.nextElementSibling as HTMLElement | null;
        if (prev && mid < prev.offsetTop + prev.offsetHeight / 2) pass(prev, () => row.after(prev));
        else if (next && mid > next.offsetTop + next.offsetHeight / 2) pass(next, () => row.before(next));
        else break;
      }
      const drawn = Math.max(0, Math.min(ul.offsetHeight - row.offsetHeight, top)); // held inside the list
      row.style.transform = `translateY(${drawn - row.offsetTop}px)`;
    };

    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!row.isConnected) { stop(); return; } // a repaint replaced the list under it
      if (!live) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD) return;
        live = true;
        row.setPointerCapture(ev.pointerId);
        row.classList.add('dragging');
      }
      follow(ev.clientY);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      stop();
      if (!live || !row.isConnected) return;
      row.classList.remove('dragging');
      row.style.transform = ''; // glides into the slot it was let go over
      // The press that began the drag still ends in a click on the row, and that click must not open the editor.
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true));
      if (row.nextElementSibling === home) return; // back where it started
      void moveTodo(t.id, (row.nextElementSibling as HTMLElement | null)?.dataset.id ?? null).then(settle);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      stop();
      if (live) render(current);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !live) return;
      ev.preventDefault(); ev.stopPropagation(); // ahead of full screen's own Escape
      stop();
      render(current); // the saved order never changed, so this puts the row back
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  };

  const render = (todos: Todo[]) => {
    current = todos;
    if (!list || !empty || !clearBtn) return;
    clear(list);
    empty.hidden = todos.length > 0;
    clearBtn.hidden = !todos.some((t) => t.done);
    for (const t of todos) {
      const textEl = el('span', { class: 'text', title: 'Click to edit, drag to reorder' }, t.text);
      const grip = el('button', { class: 'grip', type: 'button', title: 'Drag to reorder, or press ↑ and ↓', 'aria-label': `Reorder “${t.text}”`, 'aria-keyshortcuts': 'ArrowUp ArrowDown' } as any, icon(GRIP, false, 14));
      grip.onkeydown = (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        void nudge(t, e.key === 'ArrowUp' ? -1 : 1);
      };
      const row = el('li', { class: `item${t.done ? ' done' : ''}`, dataset: { id: t.id } },
        grip,
        el('input', { type: 'checkbox', checked: t.done, onchange: async () => render(await toggleTodo(t.id)) }),
        textEl,
        el('button', { class: 'x', type: 'button', title: 'Remove', onclick: async () => render(await removeTodo(t.id)) }, '×'),
      );
      textEl.onclick = () => startEdit(row, textEl, t);
      row.onpointerdown = (e) => drag(e, row, t);
      list.append(row);
    }
  };

  return {
    mount(body, actions) {
      const input = el('input', { id: 'todo-input', class: 'line-input', placeholder: 'Add a todo and press Enter', autocomplete: 'off' });
      const form = el('form', { id: 'todo-form' }, input);
      list = el('ul', { id: 'todo-list', class: 'list' });
      empty = el('p', { id: 'todo-empty', class: 'muted empty' }, 'Nothing here yet.');
      clearBtn = el('button', { id: 'todo-clear', class: 'ghost small', type: 'button', hidden: true, onclick: async () => render(await clearDone()) }, 'Clear done');
      actions.prepend(clearBtn);
      body.append(form, list, empty);
      form.onsubmit = async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        render(await addTodo(text));
      };
      void loadTodos().then(render);
      void app;
    },
    async add(text) { render(await addTodo(text)); },
  };
}

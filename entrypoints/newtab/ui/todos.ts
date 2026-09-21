import type { App } from '../app';
import { clear, el } from '@/lib/dom';
import { addTodo, clearDone, loadTodos, removeTodo, toggleTodo, type Todo } from '@/lib/todos';

export interface TodosUI {
  /** Build the panel body into a host. Ids are stable so tests and other code can find them. */
  mount(body: HTMLElement, actions: HTMLElement): void;
  /** Add a todo from anywhere (the ask bar). Persists even when the widget is not on the page. */
  add(text: string): Promise<void>;
}

export function createTodosUI(app: App): TodosUI {
  let list: HTMLElement | null = null; let empty: HTMLElement | null = null; let clearBtn: HTMLElement | null = null;

  const render = (todos: Todo[]) => {
    if (!list || !empty || !clearBtn) return;
    clear(list);
    empty.hidden = todos.length > 0;
    clearBtn.hidden = !todos.some((t) => t.done);
    for (const t of todos) {
      list.append(el('li', { class: `item${t.done ? ' done' : ''}` },
        el('input', { type: 'checkbox', checked: t.done, onchange: async () => render(await toggleTodo(t.id)) }),
        el('span', { class: 'text' }, t.text),
        el('button', { class: 'x', type: 'button', title: 'Remove', onclick: async () => render(await removeTodo(t.id)) }, '×'),
      ));
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

import type { App } from '../app';
import { $, clear, el } from '@/lib/dom';
import { addTodo, clearDone, loadTodos, removeTodo, toggleTodo, type Todo } from '@/lib/todos';

export function initTodos(app: App): void {
  const list = $('todo-list'); const input = $<HTMLInputElement>('todo-input');

  const render = (todos: Todo[]) => {
    clear(list);
    $('todo-empty').hidden = todos.length > 0;
    $('todo-clear').hidden = !todos.some((t) => t.done);
    for (const t of todos) {
      list.append(el('li', { class: `item${t.done ? ' done' : ''}` },
        el('input', { type: 'checkbox', checked: t.done, onchange: async () => render(await toggleTodo(t.id)) }),
        el('span', { class: 'text' }, t.text),
        el('button', { class: 'x', type: 'button', title: 'Remove', onclick: async () => render(await removeTodo(t.id)) }, '×'),
      ));
    }
  };

  $('todo-form').onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    render(await addTodo(text));
  };
  $('todo-clear').onclick = async () => render(await clearDone());
  void loadTodos().then(render);
  void app; // reserved: natural-language "todo:" from the ask bar comes later
}

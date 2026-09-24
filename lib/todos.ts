import { getItem, setItem, uid } from './store';

export interface Todo { id: string; text: string; done: boolean; createdAt: number }

const KEY = 'fogar.todos';
export const loadTodos = () => getItem<Todo[]>(KEY, []);
export const saveTodos = (t: Todo[]) => setItem(KEY, t);

export async function addTodo(text: string): Promise<Todo[]> {
  const todos = await loadTodos();
  todos.unshift({ id: uid(), text: text.trim(), done: false, createdAt: Date.now() });
  await saveTodos(todos);
  return todos;
}

export async function toggleTodo(id: string): Promise<Todo[]> {
  const todos = (await loadTodos()).map((t) => (t.id === id ? { ...t, done: !t.done } : t));
  await saveTodos(todos);
  return todos;
}

export async function updateTodo(id: string, text: string): Promise<Todo[]> {
  const todos = (await loadTodos()).map((t) => (t.id === id ? { ...t, text: text.trim() } : t));
  await saveTodos(todos);
  return todos;
}

/**
 * Move a todo to just in front of another one, or to the end when `before` is null: the order a drag leaves on
 * screen. Relative to a neighbour rather than an index, so a todo added in another tab meanwhile does not shift it.
 */
export async function moveTodo(id: string, before: string | null): Promise<Todo[]> {
  const todos = await loadTodos();
  const from = todos.findIndex((t) => t.id === id);
  if (from < 0 || id === before) return todos;
  const [moved] = todos.splice(from, 1);
  const to = before === null ? todos.length : todos.findIndex((t) => t.id === before);
  todos.splice(to < 0 ? from : to, 0, moved!); // a neighbour removed in another tab leaves it where it was
  await saveTodos(todos);
  return todos;
}

export async function removeTodo(id: string): Promise<Todo[]> {
  const todos = (await loadTodos()).filter((t) => t.id !== id);
  await saveTodos(todos);
  return todos;
}

export async function clearDone(): Promise<Todo[]> {
  const todos = (await loadTodos()).filter((t) => !t.done);
  await saveTodos(todos);
  return todos;
}

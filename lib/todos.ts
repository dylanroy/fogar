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

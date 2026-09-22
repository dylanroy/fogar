import { browser } from 'wxt/browser';
import { loadSettings, saveSettings } from './settings';
import type { Settings } from './llm/types';
import { loadUserRecipes, saveUserRecipes, validateRecipe, type Recipe } from './recipes';
import { loadTodos, saveTodos, type Todo } from './todos';
import { loadReminders, saveReminders, type Reminder } from './reminders';
import { getItem, setItem } from './store';
import { loadSessions, saveSessions, type Session } from './sessions';

export interface Backup {
  fogar: 1;
  exportedAt: string;
  settings: Settings;
  recipes: Recipe[];
  todos: Todo[];
  reminders: Reminder[];
  sessions?: Session[];
  layout?: unknown;
  notes?: Record<string, unknown>;
}

/** Everything Fogar knows about you, as one JSON file. Keys included: it is your own machine and your own file. */
export async function exportBackup(): Promise<Backup> {
  const all = await browser.storage.local.get(null);
  const notes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith('fogar.widget.')) notes[k] = v;
  return {
    fogar: 1,
    exportedAt: new Date().toISOString(),
    settings: await loadSettings(),
    recipes: await loadUserRecipes(),
    todos: await loadTodos(),
    reminders: await loadReminders(),
    sessions: await loadSessions(),
    layout: await getItem('fogar.layout', undefined),
    notes,
  };
}

/** Merge a backup in: recipes, todos, and reminders are appended (no duplicates by id); settings and layout replace. */
export async function importBackup(raw: unknown): Promise<{ recipes: number; todos: number; reminders: number }> {
  if (!raw || typeof raw !== 'object' || (raw as any).fogar !== 1) throw new Error('Not a Fogar backup file.');
  const b = raw as Partial<Backup>;
  let recipes = 0; let todos = 0; let reminders = 0;
  if (Array.isArray(b.recipes)) {
    const mine = await loadUserRecipes();
    for (const r of b.recipes) { const v = validateRecipe(r); if (v && !mine.some((m) => m.id === v.id)) { mine.push(v); recipes++; } }
    await saveUserRecipes(mine);
  }
  if (Array.isArray(b.todos)) {
    const mine = await loadTodos();
    for (const t of b.todos) if (t && typeof t.text === 'string' && !mine.some((m) => m.id === t.id)) { mine.push({ id: String(t.id), text: t.text, done: !!t.done, createdAt: Number(t.createdAt) || Date.now() }); todos++; }
    await saveTodos(mine);
  }
  if (Array.isArray(b.sessions)) {
    const mine = await loadSessions();
    for (const s of b.sessions) if (s && typeof s.name === 'string' && Array.isArray(s.windows) && !mine.some((m) => m.id === s.id)) mine.push(s);
    mine.sort((a, b2) => b2.savedAt - a.savedAt);
    await saveSessions(mine);
  }
  if (Array.isArray(b.reminders)) {
    const mine = await loadReminders();
    for (const r of b.reminders) if (r && typeof r.label === 'string' && Number.isFinite(r.when) && !mine.some((m) => m.id === r.id)) { mine.push({ id: String(r.id), label: r.label, when: Number(r.when), createdAt: Number(r.createdAt) || Date.now(), fired: !!r.fired }); reminders++; }
    await saveReminders(mine);
  }
  if (b.settings && typeof b.settings === 'object') { const current = await loadSettings(); await saveSettings({ ...current, ...b.settings, onboarded: true }); }
  if (b.layout) await setItem('fogar.layout', b.layout);
  if (b.notes && typeof b.notes === 'object') for (const [k, v] of Object.entries(b.notes)) if (k.startsWith('fogar.widget.')) await setItem(k, v);
  return { recipes, todos, reminders };
}

export function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import { getItem, setItem, uid } from './store';

/** Widgets are typed panels configured with data. The extension knows how to render each type; users pick, order, and configure. */
export type WidgetType =
  | 'todos' | 'reminders' | 'links' | 'notes' | 'agenda' | 'recipe' | 'weather' | 'sessions'
  | 'email' | 'feed' | 'notebook' | 'postit' | 'chat' | 'canvas' | 'jira' | 'writing';

export interface WidgetInstance {
  id: string;
  type: WidgetType;
  config: Record<string, any>;
}

export type AskPlacement = 'top' | 'centered';
/** How the page uses a wide window: one column as on narrow windows, or widgets in a right-hand rail. */
export type Arrangement = 'stack' | 'sidebar';
export type Columns = 'auto' | 2 | 3 | 4;
/** How much of a wide window the page uses; wider pages make wider columns. */
export type PageWidth = 'normal' | 'wide' | 'full';

export interface Layout {
  version: 1;
  widgets: WidgetInstance[];
  /** Focus mode: only the ask box and the conversation. */
  focus: boolean;
  ask: AskPlacement;
  arrangement: Arrangement;
  columns: Columns;
  width: PageWidth;
  showRecipes: boolean;
}

export const DEFAULT_LAYOUT: Layout = {
  version: 1,
  widgets: [
    { id: 'todos', type: 'todos', config: {} },
    { id: 'reminders', type: 'reminders', config: {} },
  ],
  focus: false,
  ask: 'top',
  arrangement: 'stack',
  columns: 'auto',
  width: 'normal',
  showRecipes: true,
};

const KEY = 'fogar.layout';
export const loadLayout = async (): Promise<Layout> => ({ ...DEFAULT_LAYOUT, ...(await getItem<Partial<Layout>>(KEY, {})) } as Layout);
export const saveLayout = async (l: Layout): Promise<void> => {
  await setItem(KEY, l);
  // Mirror the page-shape fields so public/theme-boot.js can lay the page out before the first paint.
  try { localStorage.setItem(KEY, JSON.stringify({ ask: l.ask, arrangement: l.arrangement, columns: l.columns, width: l.width, showRecipes: l.showRecipes, focus: l.focus })); } catch { /* fine */ }
};

/** The layout as attributes on the root element; the stylesheet does the rest. */
export function applyLayoutAttrs(l: Layout, root: HTMLElement = document.documentElement): void {
  root.dataset.ask = l.ask;
  root.dataset.arrangement = l.arrangement;
  root.dataset.columns = String(l.columns);
  root.dataset.width = l.width ?? 'normal';
  root.dataset.recipes = l.showRecipes ? 'shown' : 'hidden';
  root.classList.toggle('focus', l.focus);
}

export function newInstance(type: WidgetType, config: Record<string, any> = {}): WidgetInstance {
  return { id: `${type}-${uid()}`, type, config };
}

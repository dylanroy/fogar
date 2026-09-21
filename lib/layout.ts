import { getItem, setItem, uid } from './store';

/** Widgets are typed panels configured with data. The extension knows how to render each type; users pick, order, and configure. */
export type WidgetType = 'todos' | 'reminders' | 'links' | 'notes' | 'agenda' | 'recipe' | 'weather';

export interface WidgetInstance {
  id: string;
  type: WidgetType;
  config: Record<string, any>;
}

export interface Layout {
  version: 1;
  widgets: WidgetInstance[];
  /** Focus mode: only the ask box and the conversation. */
  focus: boolean;
}

export const DEFAULT_LAYOUT: Layout = {
  version: 1,
  widgets: [
    { id: 'todos', type: 'todos', config: {} },
    { id: 'reminders', type: 'reminders', config: {} },
  ],
  focus: false,
};

const KEY = 'fogar.layout';
export const loadLayout = async (): Promise<Layout> => ({ ...DEFAULT_LAYOUT, ...(await getItem<Partial<Layout>>(KEY, {})) } as Layout);
export const saveLayout = (l: Layout) => setItem(KEY, l);

export function newInstance(type: WidgetType, config: Record<string, any> = {}): WidgetInstance {
  return { id: `${type}-${uid()}`, type, config };
}

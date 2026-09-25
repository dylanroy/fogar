import type { App } from '../app';
import type { WidgetInstance, WidgetType } from '@/lib/layout';
import type { RecipesUI } from '../ui/recipes';
import type { TodosUI } from '../ui/todos';
import type { RemindersUI } from '../ui/reminders';
import { browser } from 'wxt/browser';
import { isWeb } from '@/lib/platform';
import { el } from '@/lib/dom';

/** What the widget host hands every widget. */
export interface WidgetCtx {
  app: App;
  recipes: RecipesUI;
  todos: TodosUI;
  reminders: RemindersUI;
  /** Persist an instance's config. */
  save(inst: WidgetInstance): Promise<void>;
  /** Re-render one instance in place. */
  remount(inst: WidgetInstance): void;
  /** Every instance on the page, in page order. */
  instances(): WidgetInstance[];
  /** Add an instance next to another one (before or after it, or at the end), persist, and repaint the page. */
  spawn(type: WidgetType, config: Record<string, any>, near?: { id: string; before: boolean } | null): Promise<WidgetInstance>;
  /** Is this instance the one filling the window right now? */
  isFullscreen(inst: WidgetInstance): boolean;
}

export interface WidgetDef {
  type: WidgetType;
  title: string;
  description: string;
  /** Only one on the page at a time. */
  single: boolean;
  /** Spans the full row by default; users can toggle per instance. */
  wide?: boolean;
  /** Full screen: the body stretches to the whole window instead of a readable column. Canvases and boards want this. */
  fill?: boolean;
  /** False when the widget needs extension APIs or cross-origin fetches a web page cannot make; the web app does not offer it. */
  web?: boolean;
  defaultConfig(): Record<string, any>;
  /** The header title; instances can carry their own name. */
  name(inst: WidgetInstance): string;
  render(body: HTMLElement, actions: HTMLElement, inst: WidgetInstance, ctx: WidgetCtx): void | Promise<void>;
  /** Optional settings form. Replaces the body until the user saves or cancels. */
  configure?(body: HTMLElement, inst: WidgetInstance, ctx: WidgetCtx): void;
}

export const host = (url: string) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };
/** A site's icon: Chrome's favicon service inside the extension. The web has no such service, so the host's first letter stands in. */
export const favicon = (url: string) => (isWeb() ? letterIcon(host(url)) : browser.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32` as any));
const letterIcon = (h: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#c2410c"/><text x="16" y="21.5" text-anchor="middle" font-family="system-ui, sans-serif" font-size="17" font-weight="600" fill="#fff7ed">${(h.replace(/[^a-z0-9]/gi, '')[0] ?? '?').toUpperCase()}</text></svg>`)}`;
/** A ribbon with a notch out of the bottom. Outlined when the link is not bookmarked, solid when it is. */
export const BOOKMARK = 'M6.5 3.75h11a.75.75 0 0 1 .75.75v15.75L12 16.5l-6.25 3.75V4.5a.75.75 0 0 1 .75-.75z';
/** Where a widget keeps what does not belong in the layout: caches, pages, conversations. Backups carry these keys. */
export const cacheKey = (inst: WidgetInstance) => `fogar.widget.${inst.id}`;
export const ago = (ts: number) => { const m = Math.round((Date.now() - ts) / 60e3); return m < 1 ? 'just now' : m === 1 ? '1 min ago' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
/** "just now", "3 min ago", "yesterday", "4 days ago", "Sep 3". Dates read the way people say them. */
export const relTime = (ts: number) => {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60e3);
  if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24); if (d === 1) return 'yesterday'; if (d < 7) return `${d} days ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/** A small form used by the widgets that need setup before they can render. */
export function setupForm(fields: HTMLElement[], onSave: () => Promise<void> | void, onCancel?: () => void, saveLabel = 'Save'): HTMLElement {
  const actions = el('div', { class: 'row-actions' });
  if (onCancel) actions.append(el('button', { class: 'ghost small', type: 'button', onclick: onCancel }, 'Cancel'));
  actions.append(el('button', { class: 'primary small', type: 'button', onclick: () => void onSave() }, saveLabel));
  return el('div', { class: 'setup' }, ...fields, actions);
}

/** A labelled control, the way every widget form lays them out. */
export const field = (label: string, control: HTMLElement, hint?: string) =>
  el('label', { class: 'field' }, label, control, hint ? el('span', { class: 'hint' }, hint) : null);

/** Read an image-ish file the user handed over: a photo, a screenshot, a scan. */
export const isImageFile = (f: File) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(f.name);

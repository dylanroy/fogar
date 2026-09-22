import type { App } from '../app';
import type { WidgetInstance, WidgetType } from '@/lib/layout';
import type { RecipesUI } from '../ui/recipes';
import type { TodosUI } from '../ui/todos';
import type { RemindersUI } from '../ui/reminders';
import { clear, debounce, el, fmtTime } from '@/lib/dom';
import { browser } from 'wxt/browser';
import { getItem, setItem } from '@/lib/store';
import { ensureOriginPermission } from '@/lib/settings';
import { agendaWindow, expandEvents, parseIcs, type AgendaEvent } from '@/lib/ics';
import { defaultUnit, describeWeather, fetchForecast, geocode, type Forecast, type Place } from '@/lib/weather';
import { allRecipes, type Recipe } from '@/lib/recipes';
import {
  bookmarkSession, bookmarkTabs, closeWindows, deleteSession, hasTabsPermission, hostOf, loadSessions, openWindows, removeTab, renameSession,
  requestTabsPermission, restoreSession, restoreWindow, saveSession, searchSavedTabs, SESSIONS_KEY, tabCount, topHosts, type OpenWindow, type Session,
} from '@/lib/sessions';
import { onItemChange } from '@/lib/store';

export interface WidgetCtx {
  app: App;
  recipes: RecipesUI;
  todos: TodosUI;
  reminders: RemindersUI;
  /** Persist an instance's config. */
  save(inst: WidgetInstance): Promise<void>;
  /** Re-render one instance in place. */
  remount(inst: WidgetInstance): void;
}

export interface WidgetDef {
  type: WidgetType;
  title: string;
  description: string;
  /** Only one on the page at a time. */
  single: boolean;
  defaultConfig(): Record<string, any>;
  /** The header title; instances can carry their own name. */
  name(inst: WidgetInstance): string;
  render(body: HTMLElement, actions: HTMLElement, inst: WidgetInstance, ctx: WidgetCtx): void | Promise<void>;
  /** Optional settings form. Replaces the body until the user saves or cancels. */
  configure?(body: HTMLElement, inst: WidgetInstance, ctx: WidgetCtx): void;
}

const host = (url: string) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };
const favicon = (url: string) => browser.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32` as any);
const cacheKey = (inst: WidgetInstance) => `fogar.widget.${inst.id}`;
const ago = (ts: number) => { const m = Math.round((Date.now() - ts) / 60e3); return m < 1 ? 'just now' : m === 1 ? '1 min ago' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

/** A small form used by the widgets that need setup before they can render. */
function setupForm(fields: HTMLElement[], onSave: () => Promise<void> | void, onCancel?: () => void, saveLabel = 'Save'): HTMLElement {
  const actions = el('div', { class: 'row-actions' });
  if (onCancel) actions.append(el('button', { class: 'ghost small', type: 'button', onclick: onCancel }, 'Cancel'));
  actions.append(el('button', { class: 'primary small', type: 'button', onclick: () => void onSave() }, saveLabel));
  return el('div', { class: 'setup' }, ...fields, actions);
}

// ---------- Todos ----------
const todos: WidgetDef = {
  type: 'todos', title: 'Todos', description: 'A short list, always in front of you.', single: true,
  defaultConfig: () => ({}), name: () => 'Todos',
  render(body, actions, _inst, ctx) { ctx.todos.mount(body, actions); },
};

// ---------- Reminders ----------
const reminders: WidgetDef = {
  type: 'reminders', title: 'Reminders', description: '“Call the dentist tomorrow at 9.” Fires as a Chrome notification.', single: true,
  defaultConfig: () => ({}), name: () => 'Reminders',
  render(body, _actions, _inst, ctx) { ctx.reminders.mount(body); },
};

// ---------- Links ----------
const links: WidgetDef = {
  type: 'links', title: 'Links', description: 'Your favorite sites, one click away.', single: false,
  defaultConfig: () => ({ name: 'Links', links: [] as Array<{ title: string; url: string }> }),
  name: (inst) => inst.config.name || 'Links',
  render(body, _actions, inst, ctx) {
    const list: Array<{ title: string; url: string }> = inst.config.links ?? [];
    const grid = el('div', { class: 'tiles' });
    const paint = () => {
      clear(grid);
      for (const [i, l] of list.entries()) {
        grid.append(el('a', { class: 'tile', href: l.url, title: l.url },
          el('img', { src: favicon(l.url), alt: '' }), el('span', { class: 't' }, l.title || host(l.url)),
          el('button', { class: 'x', type: 'button', title: 'Remove', onclick: async (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); list.splice(i, 1); inst.config.links = list; await ctx.save(inst); paint(); } }, '×')));
      }
      empty.hidden = list.length > 0;
    };
    const empty = el('p', { class: 'muted empty' }, 'Add a site below.');
    const url = el('input', { class: 'line-input', type: 'text', placeholder: 'example.com or a full URL', autocomplete: 'off' });
    const title = el('input', { class: 'line-input', type: 'text', placeholder: 'Name (optional)', autocomplete: 'off' });
    const form = el('form', { class: 'add-link' }, url, title, el('button', { class: 'ghost small', type: 'submit' }, 'Add'));
    form.onsubmit = async (e) => {
      e.preventDefault();
      let u = url.value.trim(); if (!u) return;
      if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
      try { new URL(u); } catch { ctx.app.toast('That does not look like a URL.'); return; }
      list.push({ title: title.value.trim(), url: u }); inst.config.links = list;
      await ctx.save(inst); url.value = ''; title.value = ''; paint();
    };
    body.append(grid, empty, form);
    paint();
  },
  configure(body, inst, ctx) {
    const name = el('input', { class: 'line-input', type: 'text', value: inst.config.name ?? 'Links' });
    clear(body);
    body.append(setupForm([el('label', { class: 'field' }, 'List name', name)], async () => { inst.config.name = name.value.trim() || 'Links'; await ctx.save(inst); ctx.remount(inst); }, () => ctx.remount(inst)));
  },
};

// ---------- Notes ----------
const notes: WidgetDef = {
  type: 'notes', title: 'Notes', description: 'A scratchpad that is there every time you open a tab.', single: false,
  defaultConfig: () => ({ name: 'Notes', text: '' }),
  name: (inst) => inst.config.name || 'Notes',
  render(body, _actions, inst, ctx) {
    const ta = el('textarea', { class: 'notes', placeholder: 'Type anything. It saves as you go.', value: inst.config.text ?? '' });
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.max(96, ta.scrollHeight)}px`; };
    const save = debounce(async () => { inst.config.text = ta.value; await ctx.save(inst); }, 400);
    ta.addEventListener('input', () => { grow(); save(); });
    body.append(ta);
    requestAnimationFrame(grow);
  },
  configure(body, inst, ctx) {
    const name = el('input', { class: 'line-input', type: 'text', value: inst.config.name ?? 'Notes' });
    clear(body);
    body.append(setupForm([el('label', { class: 'field' }, 'Title', name)], async () => { inst.config.name = name.value.trim() || 'Notes'; await ctx.save(inst); ctx.remount(inst); }, () => ctx.remount(inst)));
  },
};

// ---------- Agenda ----------
const AGENDA_TTL = 30 * 60e3;
function agendaSetup(body: HTMLElement, inst: WidgetInstance, ctx: WidgetCtx, cancellable: boolean) {
  clear(body);
  const url = el('input', { class: 'line-input', type: 'url', placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics', value: inst.config.url ?? '', autocomplete: 'off' });
  body.append(
    el('p', { class: 'muted' }, 'Paste your calendar’s private iCal address. Fogar fetches it from this browser; the address is stored here and nowhere else.'),
    setupForm([el('label', { class: 'field' }, 'iCal address', url)], async () => {
      const u = url.value.trim();
      try { new URL(u); } catch { ctx.app.toast('That does not look like a URL.'); return; }
      await ensureOriginPermission(u); // best effort: a plain fetch still works for servers that allow it
      inst.config.url = u; await setItem(cacheKey(inst), null); await ctx.save(inst); ctx.remount(inst);
    }, cancellable ? () => ctx.remount(inst) : undefined, 'Show my agenda'),
    el('p', { class: 'muted small-note' }, 'Google Calendar: Settings → your calendar → “Secret address in iCal format”. Outlook: Settings → Shared calendars → Publish. iCloud: share the calendar publicly and copy the webcal link (change webcal:// to https://).'),
  );
}
const agenda: WidgetDef = {
  type: 'agenda', title: 'Agenda', description: 'Today and tomorrow from any calendar’s iCal feed. No account connection.', single: false,
  defaultConfig: () => ({ url: '' }),
  name: () => 'Agenda',
  async render(body, actions, inst, ctx) {
    if (!inst.config.url) { agendaSetup(body, inst, ctx, false); return; }
    const status = el('p', { class: 'muted small-note' }, 'Loading…');
    const list = el('div', { class: 'agenda' });
    body.append(list, status);
    const refresh = el('a', { class: 'link', href: '#', onclick: (e: MouseEvent) => { e.preventDefault(); void load(true); } }, 'Refresh');
    const change = el('a', { class: 'link', href: '#', onclick: (e: MouseEvent) => { e.preventDefault(); agendaSetup(body, inst, ctx, true); } }, 'Change');
    const load = async (force: boolean) => {
      try {
        let cached = await getItem<{ fetchedAt: number; text: string } | null>(cacheKey(inst), null);
        if (force || !cached || Date.now() - cached.fetchedAt > AGENDA_TTL) {
          status.textContent = 'Fetching…';
          const res = await fetch(inst.config.url, { cache: 'no-store' });
          if (!res.ok) throw new Error(`The calendar returned ${res.status}`);
          cached = { fetchedAt: Date.now(), text: await res.text() };
          await setItem(cacheKey(inst), cached);
        }
        const { start, end } = agendaWindow();
        const events = expandEvents(parseIcs(cached.text), start, end);
        paint(events, start);
        clear(status); status.append(`Updated ${ago(cached.fetchedAt)} · `, refresh, ' · ', change);
      } catch (err) {
        clear(list);
        clear(status); status.append(`Could not load the calendar: ${(err as Error).message}. `, refresh, ' · ', change);
      }
    };
    const paint = (events: AgendaEvent[], dayStart: number) => {
      clear(list);
      const days: Array<[string, number, number]> = [['Today', dayStart, dayStart + 86400e3], ['Tomorrow', dayStart + 86400e3, dayStart + 2 * 86400e3]];
      const now = Date.now();
      for (const [label, s, e] of days) {
        const todays = events.filter((ev) => ev.start < e && ev.end > s);
        list.append(el('h4', {}, label, todays.length ? '' : el('span', { class: 'muted' }, '  nothing scheduled')));
        for (const ev of todays) {
          const past = ev.end <= now;
          const time = ev.allDay ? 'All day' : `${new Date(Math.max(ev.start, s)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}–${new Date(Math.min(ev.end, e)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
          list.append(el('div', { class: `event${past ? ' past' : ''}${!past && ev.start <= now ? ' now' : ''}` },
            el('span', { class: 'when' }, time), el('span', { class: 'what' }, ev.summary, ev.location ? el('span', { class: 'where' }, ` · ${ev.location}`) : '')));
        }
      }
    };
    void load(false);
    void actions; void fmtTime;
  },
  configure(body, inst, ctx) { agendaSetup(body, inst, ctx, true); },
};

// ---------- Recipe ----------
const recipe: WidgetDef = {
  type: 'recipe', title: 'Recipe', description: 'Pin a recipe’s form to the page.', single: false,
  defaultConfig: () => ({ recipeId: '' }),
  name: (inst) => inst.config.recipeName || 'Recipe',
  async render(body, _actions, inst, ctx) {
    const r: Recipe | undefined = (await allRecipes()).find((x) => x.id === inst.config.recipeId);
    if (!r) { recipe.configure!(body, inst, ctx); return; }
    body.append(ctx.recipes.buildRunForm(r));
  },
  configure(body, inst, ctx) {
    clear(body);
    const sel = el('select', { class: 'line-input' });
    void allRecipes().then((all) => { for (const r of all) sel.append(new Option(`${r.emoji ?? ''} ${r.name}`.trim(), r.id, false, r.id === inst.config.recipeId)); });
    body.append(setupForm([el('label', { class: 'field' }, 'Recipe', sel)], async () => {
      const all = await allRecipes(); const r = all.find((x) => x.id === sel.value); if (!r) return;
      inst.config.recipeId = r.id; inst.config.recipeName = r.name; await ctx.save(inst); ctx.remount(inst);
    }, inst.config.recipeId ? () => ctx.remount(inst) : undefined, 'Pin recipe'));
  },
};

// ---------- Weather ----------
const WEATHER_TTL = 30 * 60e3;
function weatherSetup(body: HTMLElement, inst: WidgetInstance, ctx: WidgetCtx, cancellable: boolean) {
  clear(body);
  const city = el('input', { class: 'line-input', type: 'text', placeholder: 'City, e.g. Denver', autocomplete: 'off', value: inst.config.place?.name ?? '' });
  const results = el('div', { class: 'places' });
  const search = async () => {
    const q = city.value.trim(); if (!q) return;
    clear(results); results.append(el('p', { class: 'muted' }, 'Searching…'));
    try {
      const places: Place[] = await geocode(q, inst.config.geocodeEndpoint);
      clear(results);
      if (!places.length) results.append(el('p', { class: 'muted' }, 'No place found with that name.'));
      for (const p of places) results.append(el('button', { class: 'ghost small', type: 'button', onclick: async () => {
        inst.config.place = p; inst.config.unit = inst.config.unit ?? defaultUnit(); await setItem(cacheKey(inst), null); await ctx.save(inst); ctx.remount(inst);
      } }, `${p.name}${p.region ? `, ${p.region}` : ''}${p.country ? `, ${p.country}` : ''}`));
    } catch (err) { clear(results); results.append(el('p', { class: 'muted' }, `Lookup failed: ${(err as Error).message}`)); }
  };
  const form = el('form', { class: 'add-link' }, city, el('button', { class: 'ghost small', type: 'submit' }, 'Search'));
  form.onsubmit = (e) => { e.preventDefault(); void search(); };
  body.append(el('p', { class: 'muted' }, 'Weather comes from Open-Meteo, which needs no account or key. Your city is the only thing sent.'), form, results);
  if (cancellable) body.append(el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', onclick: () => ctx.remount(inst) }, 'Cancel')));
}
const weather: WidgetDef = {
  type: 'weather', title: 'Weather', description: 'Now and the next few days, from Open-Meteo. No key needed.', single: false,
  defaultConfig: () => ({ place: null, unit: defaultUnit() }),
  name: (inst) => inst.config.place?.name ? `Weather · ${inst.config.place.name}` : 'Weather',
  async render(body, _actions, inst, ctx) {
    const place: Place | null = inst.config.place;
    if (!place) { weatherSetup(body, inst, ctx, false); return; }
    const unit: 'c' | 'f' = inst.config.unit ?? defaultUnit();
    const status = el('p', { class: 'muted small-note' }, 'Loading…');
    const box = el('div', { class: 'weather' });
    body.append(box, status);
    try {
      let cached = await getItem<Forecast | null>(cacheKey(inst), null);
      if (!cached || cached.unit !== unit || Date.now() - cached.fetchedAt > WEATHER_TTL) {
        cached = await fetchForecast(place.lat, place.lon, unit, inst.config.endpoint);
        await setItem(cacheKey(inst), cached);
      }
      const cur = describeWeather(cached.current.code);
      const deg = unit === 'f' ? '°F' : '°C';
      box.append(
        el('div', { class: 'now' }, el('span', { class: 'temp' }, `${cached.current.temp}°`), el('span', { class: 'cond' }, `${cur.icon} ${cur.label}`, el('br'), el('span', { class: 'muted' }, `H ${cached.daily[0]?.hi}° · L ${cached.daily[0]?.lo}° · wind ${cached.current.wind} ${unit === 'f' ? 'mph' : 'km/h'}`))),
        el('div', { class: 'days' }, ...cached.daily.slice(1, 4).map((d) => el('div', { class: 'day' }, el('span', { class: 'muted' }, new Date(`${d.date}T12:00:00`).toLocaleDateString([], { weekday: 'short' })), el('span', {}, describeWeather(d.code).icon), el('span', { class: 'hilo' }, `${d.hi}° / ${d.lo}°`)))),
      );
      clear(status);
      status.append(`Updated ${ago(cached.fetchedAt)} · `,
        el('a', { class: 'link', href: '#', onclick: async (e: MouseEvent) => { e.preventDefault(); inst.config.unit = unit === 'f' ? 'c' : 'f'; await ctx.save(inst); ctx.remount(inst); } }, unit === 'f' ? 'Use °C' : 'Use °F'),
        ' · ', el('a', { class: 'link', href: '#', onclick: (e: MouseEvent) => { e.preventDefault(); weatherSetup(body, inst, ctx, true); } }, 'Change'));
      void deg;
    } catch (err) {
      clear(status); status.append(`Could not load the forecast: ${(err as Error).message}. `, el('a', { class: 'link', href: '#', onclick: (e: MouseEvent) => { e.preventDefault(); ctx.remount(inst); } }, 'Retry'));
    }
  },
  configure(body, inst, ctx) { weatherSetup(body, inst, ctx, true); },
};


// ---------- Sessions ----------
const relTime = (ts: number) => { const m = Math.round((Date.now() - ts) / 60e3); if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 24) return `${h} h ago`; const d = Math.round(h / 24); return d === 1 ? 'yesterday' : `${d} days ago`; };
const sessions: WidgetDef = {
  type: 'sessions', title: 'Sessions', description: 'Save your open windows, close them without fear, search and restore later.', single: true,
  defaultConfig: () => ({}), name: () => 'Sessions',
  async render(body, _actions, inst, ctx) {
    const { app } = ctx;
    if (!(await hasTabsPermission())) {
      body.append(el('div', { class: 'perm-ask' },
        el('p', { class: 'muted' }, 'To save and restore your windows, Fogar needs to read the titles and addresses of your open tabs. Chrome calls this permission “Read your browsing history”; Fogar only looks at open tabs, only when this widget is on the page, and everything it saves stays on this device.'),
        el('div', { class: 'row-actions' }, el('button', { class: 'primary small', type: 'button', onclick: async () => {
          const ok = await requestTabsPermission();
          if (ok) ctx.remount(inst); else app.toast('Without that permission the Sessions widget cannot see your tabs.');
        } }, 'Allow Fogar to see my tabs'))));
      return;
    }

    const openBox = el('div', { class: 'sess-open' });
    const search = el('input', { class: 'line-input', type: 'search', placeholder: 'Search saved tabs', autocomplete: 'off' });
    const savedBox = el('div', { class: 'sess-saved' });
    body.append(openBox, search, savedBox);
    const expanded = new Set<string>();

    // ---- open windows ----
    const paintOpen = async () => {
      const { windows, totalTabs } = await openWindows();
      clear(openBox);
      const withTabs = windows.filter((w) => w.tabs.length);
      const saveMany = async (list: OpenWindow[], close: boolean) => {
        const res = await saveSession(list);
        if (!res) { app.toast('Nothing to save: only browser pages are open.'); return; }
        app.toast(`Saved ${tabCount(res.session)} tab${tabCount(res.session) === 1 ? '' : 's'} as “${res.session.name}”${res.duplicates ? `, ${res.duplicates} duplicate${res.duplicates === 1 ? '' : 's'} dropped` : ''}.`);
        if (close) await closeWindows(list.map((w) => w.id));
        void paintOpen(); void paintSaved();
      };
      openBox.append(el('div', { class: 'sess-head' },
        el('span', {}, `${windows.length} window${windows.length === 1 ? '' : 's'} · ${totalTabs} tab${totalTabs === 1 ? '' : 's'} open`),
        el('span', { class: 'row-actions' },
          el('button', { class: 'ghost small', type: 'button', disabled: !withTabs.length, onclick: () => void saveMany(withTabs, false) }, 'Save all'),
          el('button', { class: 'ghost small', type: 'button', disabled: !withTabs.some((w) => !w.current), title: 'Save every window, then close all of them except this one', onclick: () => void saveMany(withTabs.filter((w) => !w.current), true) }, 'Save & close others'))));
      withTabs.forEach((w, i) => {
        openBox.append(el('div', { class: 'sess-win' },
          el('span', { class: 't' }, el('strong', {}, w.current ? 'This window' : `Window ${i + 1}`), ` · ${w.tabs.length} tab${w.tabs.length === 1 ? '' : 's'}`, el('span', { class: 'muted' }, ` · ${topHosts(w.tabs).join(', ')}`)),
          el('button', { class: 'ghost small', type: 'button', onclick: () => void saveMany([w], false) }, 'Save'),
          el('button', { class: 'ghost small', type: 'button', title: w.current ? 'Saves this window and closes it, including this tab' : 'Save this window, then close it', onclick: () => void saveMany([w], true) }, 'Save & close')));
      });
    };

    // ---- saved sessions ----
    const tabRow = (s: Session, t: { id: string; url: string; title: string }, showSession: boolean) =>
      el('div', { class: 'sess-tab' },
        el('img', { src: favicon(t.url), alt: '' }),
        el('a', { href: t.url, target: '_blank', rel: 'noopener', title: t.url }, t.title),
        el('span', { class: 'h' }, showSession ? `${s.name} · ${hostOf(t.url)}` : hostOf(t.url)),
        el('button', { class: 'bm', type: 'button', title: 'Bookmark into a folder named after this session', onclick: async () => { const r = await bookmarkTabs(s, [t]); app.toast(r.added ? `Bookmarked into “${s.name}”` : 'Already in that folder'); } }, '📑'),
        el('button', { class: 'x', type: 'button', title: 'Remove from this session', onclick: async () => { await removeTab(s.id, t.id); void paintSaved(); } }, '×'));

    const paintSaved = async () => {
      const all = await loadSessions();
      clear(savedBox);
      const q = search.value.trim();
      if (q) {
        const hits = await searchSavedTabs(q, 40);
        savedBox.append(el('p', { class: 'muted small-note' }, hits.length ? `${hits.length} saved tab${hits.length === 1 ? '' : 's'} match` : 'No saved tabs match.'));
        for (const h of hits) savedBox.append(tabRow(h.session, h.tab, true));
        return;
      }
      if (!all.length) { savedBox.append(el('p', { class: 'muted empty' }, 'Nothing saved yet. Save a window above and you can close it knowing every tab is one search away.')); return; }
      for (const s of all) {
        const n = tabCount(s);
        const row = el('div', { class: 'sess-session', dataset: { id: s.id } });
        const name = el('button', { class: 'sess-name', type: 'button', title: expanded.has(s.id) ? 'Collapse' : 'Show tabs', onclick: () => { if (expanded.has(s.id)) expanded.delete(s.id); else expanded.add(s.id); void paintSaved(); } }, `${expanded.has(s.id) ? '▾' : '▸'} ${s.name}`);
        const rename = () => {
          const input = el('input', { class: 'line-input', type: 'text', value: s.name });
          const done = async () => { await renameSession(s.id, input.value); void paintSaved(); };
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void done(); if (e.key === 'Escape') void paintSaved(); });
          input.addEventListener('blur', () => void done());
          name.replaceWith(input); input.focus(); input.select();
        };
        // Name and meta on one line, actions on the next: in a narrow widget column the buttons would otherwise
        // squeeze the name to nothing.
        row.append(el('div', { class: 'sess-row' }, name,
          el('span', { class: 'sess-meta' }, `${n} tab${n === 1 ? '' : 's'} · ${relTime(s.savedAt)}`)),
          el('div', { class: 'sess-actions' },
            el('button', { class: 'ghost small', type: 'button', title: 'Reopen every window in this session; tabs load when you click them', onclick: async () => { await restoreSession(s); app.toast(`Restored “${s.name}”`); void paintOpen(); } }, 'Restore'),
            el('button', { class: 'ghost small', type: 'button', title: 'Copy every tab into a bookmark folder named after this session', onclick: async () => { const r = await bookmarkSession(s); app.toast(`${r.added} bookmarked into “${s.name}”${r.skipped ? `, ${r.skipped} already there` : ''}`); } }, 'Bookmark all'),
            el('button', { class: 'ctl', type: 'button', title: 'Rename', onclick: rename }, '✎'),
            el('button', { class: 'ctl', type: 'button', title: 'Delete this saved session', onclick: async () => { if (!confirm(`Delete “${s.name}” (${n} tabs)? This cannot be undone.`)) return; await deleteSession(s.id); void paintSaved(); } }, '×')));
        if (expanded.has(s.id)) {
          s.windows.forEach((w, i) => {
            const tabs = el('div', { class: 'sess-tabs' });
            if (s.windows.length > 1) tabs.append(el('div', { class: 'sess-row muted' }, el('span', { class: 't' }, `Window ${i + 1} · ${w.tabs.length} tabs`), el('button', { class: 'ghost small', type: 'button', onclick: async () => { await restoreWindow(w); void paintOpen(); } }, 'Restore window')));
            for (const t of w.tabs) tabs.append(tabRow(s, t, false));
            row.append(tabs);
          });
        }
        savedBox.append(row);
      }
    };

    search.addEventListener('input', debounce(() => void paintSaved(), 120));
    onItemChange(SESSIONS_KEY, () => void paintSaved());
    const repaintOpen = debounce(() => void paintOpen(), 400);
    for (const ev of [browser.windows.onCreated, browser.windows.onRemoved, browser.tabs.onCreated, browser.tabs.onRemoved, browser.tabs.onUpdated] as Array<{ addListener(cb: () => void): void }>) ev.addListener(repaintOpen);
    await paintOpen();
    await paintSaved();
  },
};

export const WIDGETS: WidgetDef[] = [todos, reminders, agenda, sessions, links, notes, weather, recipe];
export const widgetDef = (type: WidgetType): WidgetDef => WIDGETS.find((w) => w.type === type)!;

import type { WidgetInstance } from '@/lib/layout';
import { clear, el } from '@/lib/dom';
import { getItem, setItem, uid } from '@/lib/store';
import { ensureOriginPermission } from '@/lib/settings';
import { QUERY_PROVIDERS, fetchSource, mergeItems, sourceLabel, sourceUrl, type FeedItem, type FeedSource, type QueryProvider } from '@/lib/feeds';
import { ago, cacheKey, favicon, field, relTime, setupForm, type WidgetCtx, type WidgetDef } from './shared';

/**
 * Feed: a reading list built from RSS and Atom feeds and from searches that publish a feed (Google News,
 * Hacker News, Reddit, Bing News). Everything is merged newest first; a dot marks what arrived since you last
 * said "mark all read". Fetched from this browser to each source's own origin.
 */
const TTL = 15 * 60e3;

interface FeedConfig { name: string; sources: FeedSource[]; count: number; /** Test hook: a local server standing in for every query provider. */ testQueryUrl?: string }
interface FeedCache { fetchedAt: number; items: FeedItem[]; titles: Record<string, string>; errors: Record<string, string>; lastSeen: number }

const cfgOf = (inst: WidgetInstance): FeedConfig => ({ name: 'Feed', sources: [], count: 20, ...(inst.config as Partial<FeedConfig>) });

function sourcesForm(body: HTMLElement, inst: WidgetInstance, ctx: WidgetCtx, cancellable: boolean) {
  clear(body);
  const cfg = cfgOf(inst);
  const sources: FeedSource[] = cfg.sources.map((s) => ({ ...s }));
  const list = el('div', { class: 'src-list' });
  const paintList = () => {
    clear(list);
    if (!sources.length) list.append(el('p', { class: 'muted empty' }, 'No sources yet. Add a feed address, a site, or a search below.'));
    for (const s of sources) {
      list.append(el('div', { class: 'src-row' },
        el('span', { class: 'src-kind' }, s.kind === 'rss' ? 'feed' : 'search'),
        el('span', { class: 'src-label', title: sourceUrl(s, cfg.testQueryUrl) }, sourceLabel(s)),
        el('button', { class: 'x', type: 'button', title: 'Remove', onclick: () => { sources.splice(sources.indexOf(s), 1); paintList(); } }, '×')));
    }
  };
  paintList();
  const kind = el('select', { class: 'line-input' });
  kind.append(new Option('Feed or site address', 'rss'));
  for (const p of QUERY_PROVIDERS) kind.append(new Option(`Search ${p.label}`, p.id));
  const input = el('input', { class: 'line-input', type: 'text', placeholder: 'https://example.com/feed.xml, or just example.com', autocomplete: 'off' });
  kind.onchange = () => { input.placeholder = kind.value === 'rss' ? 'https://example.com/feed.xml, or just example.com' : 'Words to search for, e.g. "local-first software"'; input.focus(); };
  const add = async () => {
    const v = input.value.trim(); if (!v) return;
    if (kind.value === 'rss') {
      let u = v; if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
      try { new URL(u); } catch { ctx.app.toast('That does not look like a web address.'); return; }
      await ensureOriginPermission(u); // best effort: feeds that allow cross-origin reads work without it
      sources.push({ id: uid(), kind: 'rss', url: u });
    } else {
      const provider = kind.value as QueryProvider;
      await ensureOriginPermission(QUERY_PROVIDERS.find((p) => p.id === provider)!.url(v));
      sources.push({ id: uid(), kind: 'query', provider, q: v });
    }
    input.value = ''; paintList();
  };
  const addRow = el('form', { class: 'add-src' }, kind, input, el('button', { class: 'ghost small', type: 'submit' }, 'Add'));
  addRow.onsubmit = (e) => { e.preventDefault(); void add(); };
  const name = el('input', { class: 'line-input', type: 'text', value: cfg.name });
  const count = el('select', { class: 'line-input' });
  for (const n of [10, 20, 40]) count.append(new Option(`${n} items`, String(n), false, n === cfg.count));
  body.append(
    el('p', { class: 'muted' }, 'A site address is enough: Fogar looks for the feed it advertises. Searches come from the provider as a feed, newest first. Each source is fetched from this browser, straight from its own site.'),
    list, addRow,
    el('div', { class: 'grid-2' }, field('Title', name), field('Show', count)),
    setupForm([], async () => {
      if (!sources.length) { ctx.app.toast('Add at least one source.'); return; }
      inst.config = { ...inst.config, name: name.value.trim() || 'Feed', sources, count: Number(count.value) || 20 };
      await setItem(cacheKey(inst), null); await ctx.save(inst); ctx.remount(inst);
    }, cancellable ? () => ctx.remount(inst) : undefined, 'Show the feed'),
  );
}

export const feed: WidgetDef = {
  type: 'feed', title: 'Feed', description: 'RSS and Atom feeds and saved searches, merged into one reading list.', single: false,
  defaultConfig: () => ({ name: 'Feed', sources: [], count: 20 }),
  name: (inst) => inst.config.name || 'Feed',
  async render(body, actions, inst, ctx) {
    const cfg = cfgOf(inst);
    if (!cfg.sources.length) { sourcesForm(body, inst, ctx, false); return; }
    const list = el('div', { class: 'feed' });
    const status = el('p', { class: 'muted small-note' }, 'Loading…');
    body.append(list, status);
    const refresh = el('a', { class: 'link', href: '#', onclick: (e: MouseEvent) => { e.preventDefault(); void load(true); } }, 'Refresh');
    const sourcesLink = el('a', { class: 'link', href: '#', onclick: (e: MouseEvent) => { e.preventDefault(); sourcesForm(body, inst, ctx, true); } }, 'Sources');
    let cache: FeedCache | null = null;
    const markRead = el('a', { class: 'link', href: '#', onclick: async (e: MouseEvent) => { e.preventDefault(); if (!cache) return; cache.lastSeen = Date.now(); await setItem(cacheKey(inst), cache); paint(); } }, 'Mark all read');
    const markReadBtn = el('button', { class: 'ghost small feed-mark', type: 'button', hidden: true, onclick: () => markRead.click() }, 'Mark read');
    actions.append(markReadBtn);

    const paint = () => {
      if (!cache) return;
      clear(list);
      const fresh = cache.items.filter((it) => it.date > cache!.lastSeen).length;
      markReadBtn.hidden = fresh === 0;
      if (!cache.items.length) list.append(el('p', { class: 'muted empty' }, 'Nothing in these feeds yet.'));
      for (const it of cache.items) {
        list.append(el('a', { class: `feed-item${it.date > cache.lastSeen ? ' new' : ''}`, href: it.url, target: '_blank', rel: 'noopener', title: it.url },
          el('img', { class: 'fav', src: favicon(it.url), alt: '' }),
          el('span', { class: 'fi-main' },
            el('span', { class: 't' }, it.title),
            it.snippet ? el('span', { class: 'snip' }, it.snippet) : null,
            el('span', { class: 'meta' }, `${it.source}${it.author ? ` · ${it.author}` : ''}${it.date ? ` · ${relTime(it.date)}` : ''}`))));
      }
      clear(status);
      const failed = Object.entries(cache.errors);
      status.append(`${cache.items.length} item${cache.items.length === 1 ? '' : 's'} from ${cfg.sources.length} source${cfg.sources.length === 1 ? '' : 's'} · updated ${ago(cache.fetchedAt)} · `, refresh, ' · ', markRead, ' · ', sourcesLink);
      if (failed.length) status.append(el('span', { class: 'warn' }, ` · ${failed.map(([id, msg]) => `${cache!.titles[id] ?? sourceLabel(cfg.sources.find((s) => s.id === id)!)}: ${msg}`).join('; ')}`));
    };

    const load = async (force: boolean) => {
      try {
        cache = await getItem<FeedCache | null>(cacheKey(inst), null);
        if (cache && Array.isArray(cache.items)) {
          // A source added or removed since the last fetch invalidates the merge.
          const known = new Set(cfg.sources.map((s) => s.id));
          if (cache.items.some((it) => !known.has(it.sourceId))) force = true;
        } else cache = null;
        if (force || !cache || Date.now() - cache.fetchedAt > TTL) {
          status.textContent = 'Fetching…';
          const results = await Promise.allSettled(cfg.sources.map((s) => fetchSource(s, { testQueryUrl: cfg.testQueryUrl })));
          const titles: Record<string, string> = { ...(cache?.titles ?? {}) }; const errors: Record<string, string> = {};
          const lists: FeedItem[][] = [];
          let discoveredAny = false;
          results.forEach((r, i) => {
            const s = cfg.sources[i]!;
            if (r.status === 'fulfilled') {
              titles[s.id] = r.value.title; lists.push(r.value.items);
              // A site address that led to a feed is remembered as that feed, so the next refresh skips the page.
              if (r.value.discovered && s.kind === 'rss') { s.url = r.value.discovered; s.title = s.title || r.value.title; discoveredAny = true; }
            } else errors[s.id] = String((r.reason as Error)?.message ?? r.reason);
          });
          if (discoveredAny) { inst.config.sources = cfg.sources; await ctx.save(inst); }
          if (!lists.length && Object.keys(errors).length) throw new Error(Object.values(errors)[0]!);
          cache = { fetchedAt: Date.now(), items: mergeItems(lists, cfg.count), titles, errors, lastSeen: cache?.lastSeen ?? 0 };
          await setItem(cacheKey(inst), cache);
        }
        paint();
      } catch (err) {
        clear(list); clear(status);
        status.append(`Could not load the feed: ${(err as Error).message} `, refresh, ' · ', sourcesLink);
      }
    };
    void load(false);
  },
  configure(body, inst, ctx) { sourcesForm(body, inst, ctx, true); },
};

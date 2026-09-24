/**
 * Feeds: RSS 2.0, Atom, RSS 1.0 (RDF), and JSON Feed, plus "search as a feed" providers that publish a feed
 * for any query. Everything is fetched from this browser to the feed's own origin, which is requested as an
 * optional host permission when the source is added. Nothing is proxied and nothing is stored but the items.
 */
export type QueryProvider = 'google-news' | 'reddit' | 'hn' | 'bing-news';

export type FeedSource =
  | { id: string; kind: 'rss'; url: string; title?: string }
  | { id: string; kind: 'query'; provider: QueryProvider; q: string; title?: string };

export interface FeedItem {
  id: string;
  title: string;
  url: string;
  snippet: string;
  /** Milliseconds; 0 when the feed gave no date. */
  date: number;
  author?: string;
  /** The source's title and id, so a merged list can say where a line came from. */
  source: string;
  sourceId: string;
}

export const QUERY_PROVIDERS: Array<{ id: QueryProvider; label: string; note: string; url: (q: string) => string }> = [
  { id: 'google-news', label: 'Google News', note: 'Headlines from thousands of outlets, newest first.', url: (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en` },
  { id: 'hn', label: 'Hacker News', note: 'New stories and comments matching the words, via hnrss.org.', url: (q) => `https://hnrss.org/newest?q=${encodeURIComponent(q)}` },
  { id: 'reddit', label: 'Reddit', note: 'New posts across Reddit that match.', url: (q) => `https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=new` },
  { id: 'bing-news', label: 'Bing News', note: 'Another news index; different outlets surface.', url: (q) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss` },
];

export const providerLabel = (p: QueryProvider) => QUERY_PROVIDERS.find((x) => x.id === p)?.label ?? p;

/** Where a source is fetched from. `testQueryUrl` is a test hook: it replaces every query provider with a local server. */
export function sourceUrl(src: FeedSource, testQueryUrl?: string): string {
  if (src.kind === 'rss') return src.url;
  if (testQueryUrl) return `${testQueryUrl}?provider=${src.provider}&q=${encodeURIComponent(src.q)}`;
  return QUERY_PROVIDERS.find((p) => p.id === src.provider)!.url(src.q);
}

export function sourceLabel(src: FeedSource): string {
  if (src.title) return src.title;
  if (src.kind === 'query') return `${providerLabel(src.provider)}: ${src.q}`;
  try { return new URL(src.url).host.replace(/^www\./, ''); } catch { return src.url; }
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** HTML in a description becomes the text a reader would see, cut to a line or two. */
export function textOfHtml(html: string, max = 240): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const n of doc.querySelectorAll('script,style')) n.remove();
  const text = collapse(doc.body?.textContent ?? '');
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const text = (parent: Element | null | undefined, ...names: string[]): string => {
  if (!parent) return '';
  for (const name of names) {
    // Namespaced names (dc:date) arrive with a prefix in XML documents; match on the local name too.
    for (const child of Array.from(parent.children)) {
      if (child.tagName === name || child.localName === name.replace(/^.*:/, '')) {
        const t = child.textContent ?? '';
        if (t.trim()) return t.trim();
      }
    }
  }
  return '';
};

const parseDate = (s: string): number => {
  if (!s) return 0;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? t : 0;
};

const absolute = (href: string, base?: string): string => { try { return new URL(href, base).href; } catch { return href; } };

/** A stable id for an item: the guid or link, or a hash of the title and date. */
function itemId(guid: string, url: string, title: string, date: number): string {
  const base = guid || url || `${title}|${date}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export interface ParsedFeed { kind: 'feed'; title: string; items: Array<Omit<FeedItem, 'source' | 'sourceId'>> }
export interface ParsedPage { kind: 'html'; alternate?: string; title?: string }

/**
 * Parse whatever a feed URL returned. A web page with a `<link rel="alternate">` to a feed comes back as `html`
 * with that address, so a source can be a site's homepage and Fogar finds the feed itself.
 */
export function parseFeedDocument(body: string, baseUrl?: string, contentType = ''): ParsedFeed | ParsedPage {
  const trimmed = body.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('{') || /json/.test(contentType)) {
    try { return parseJsonFeed(JSON.parse(trimmed)); } catch { /* not JSON Feed; fall through */ }
  }
  const looksHtml = /^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed) || /text\/html/.test(contentType);
  if (looksHtml) {
    const doc = new DOMParser().parseFromString(body, 'text/html');
    const link = doc.querySelector('link[rel~="alternate"][type*="rss"], link[rel~="alternate"][type*="atom"], link[rel~="alternate"][type*="feed+json"]');
    const href = link?.getAttribute('href');
    return { kind: 'html', alternate: href ? absolute(href, baseUrl) : undefined, title: doc.title || undefined };
  }
  const xml = new DOMParser().parseFromString(body, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('That address did not return a feed Fogar can read.');
  const root = xml.documentElement;
  const rootName = root.localName.toLowerCase();
  if (rootName === 'feed') return parseAtom(root, baseUrl);
  if (rootName === 'rss') return parseRss(root.querySelector('channel') ?? root, baseUrl);
  if (rootName === 'rdf') return parseRdf(root, baseUrl);
  throw new Error(`That address returned ${rootName ? `<${rootName}>` : 'something'} rather than a feed.`);
}

function parseRss(channel: Element, baseUrl?: string): ParsedFeed {
  const title = collapse(text(channel, 'title'));
  const items = Array.from(channel.querySelectorAll('item')).map((it) => {
    const link = text(it, 'link') || it.querySelector('link')?.getAttribute('href') || text(it, 'guid');
    const url = absolute(link, baseUrl);
    const date = parseDate(text(it, 'pubDate', 'dc:date', 'date'));
    const t = collapse(text(it, 'title')) || url;
    return { id: itemId(text(it, 'guid'), url, t, date), title: t, url, snippet: textOfHtml(text(it, 'description', 'content:encoded', 'encoded', 'summary')), date, author: collapse(text(it, 'dc:creator', 'creator', 'author')) || undefined };
  });
  return { kind: 'feed', title, items };
}

function parseAtom(feed: Element, baseUrl?: string): ParsedFeed {
  const title = collapse(text(feed, 'title'));
  const items = Array.from(feed.children).filter((c) => c.localName === 'entry').map((en) => {
    const links = Array.from(en.children).filter((c) => c.localName === 'link');
    const alt = links.find((l) => !l.getAttribute('rel') || l.getAttribute('rel') === 'alternate') ?? links[0];
    const url = absolute(alt?.getAttribute('href') ?? text(en, 'id'), baseUrl);
    const date = parseDate(text(en, 'published', 'updated', 'issued'));
    const t = collapse(text(en, 'title')) || url;
    const author = en.querySelector('author > name')?.textContent?.trim() || undefined;
    return { id: itemId(text(en, 'id'), url, t, date), title: t, url, snippet: textOfHtml(text(en, 'summary', 'content')), date, author };
  });
  return { kind: 'feed', title, items };
}

function parseRdf(root: Element, baseUrl?: string): ParsedFeed {
  const title = collapse(text(root.querySelector('channel'), 'title'));
  const items = Array.from(root.children).filter((c) => c.localName === 'item').map((it) => {
    const url = absolute(text(it, 'link') || it.getAttribute('rdf:about') || it.getAttribute('about') || '', baseUrl);
    const date = parseDate(text(it, 'dc:date', 'date'));
    const t = collapse(text(it, 'title')) || url;
    return { id: itemId(url, url, t, date), title: t, url, snippet: textOfHtml(text(it, 'description')), date, author: collapse(text(it, 'dc:creator', 'creator')) || undefined };
  });
  return { kind: 'feed', title, items };
}

function parseJsonFeed(j: any): ParsedFeed {
  if (!j || typeof j !== 'object' || !Array.isArray(j.items)) throw new Error('not a JSON Feed');
  const items = (j.items as any[]).map((it) => {
    const url = String(it.url ?? it.external_url ?? '');
    const date = parseDate(String(it.date_published ?? it.date_modified ?? ''));
    const t = collapse(String(it.title ?? '')) || url;
    const snippet = it.content_text ? collapse(String(it.content_text)).slice(0, 240) : textOfHtml(String(it.content_html ?? it.summary ?? ''));
    const author = it.authors?.[0]?.name ?? it.author?.name;
    return { id: itemId(String(it.id ?? ''), url, t, date), title: t, url, snippet, date, author: author ? String(author) : undefined };
  });
  return { kind: 'feed', title: collapse(String(j.title ?? '')), items };
}

export interface FetchedSource { title: string; items: FeedItem[]; /** The feed address found on a web page, when the source was a page rather than a feed. */ discovered?: string }

/** Fetch one source. A source that is a web page is followed to its advertised feed, once. */
export async function fetchSource(src: FeedSource, opts: { signal?: AbortSignal; testQueryUrl?: string } = {}): Promise<FetchedSource> {
  const url = sourceUrl(src, opts.testQueryUrl);
  const load = async (u: string) => {
    const res = await fetch(u, { signal: opts.signal, cache: 'no-store', headers: { Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.5, */*;q=0.1' } });
    if (!res.ok) throw new Error(`${sourceLabel(src)} returned ${res.status}`);
    return { body: await res.text(), type: res.headers.get('content-type') ?? '' };
  };
  let discovered: string | undefined;
  let { body, type } = await load(url);
  let parsed = parseFeedDocument(body, url, type);
  if (parsed.kind === 'html') {
    if (!parsed.alternate) throw new Error(`${sourceLabel(src)} is a web page with no feed link on it.`);
    discovered = parsed.alternate;
    ({ body, type } = await load(discovered));
    parsed = parseFeedDocument(body, discovered, type);
    if (parsed.kind === 'html') throw new Error(`${sourceLabel(src)} pointed at another web page, not a feed.`);
  }
  const title = src.title || parsed.title || sourceLabel(src);
  return { title, items: parsed.items.map((it) => ({ ...it, source: title, sourceId: src.id })), discovered };
}

/** Newest first across sources, the same address listed once, cut to `limit`. Undated items keep their feed order at the end. */
export function mergeItems(lists: FeedItem[][], limit: number): FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const list of lists) for (const it of list) {
    const key = it.url.replace(/^https?:\/\/(www\.)?/, '').replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase() || it.id;
    if (seen.has(key)) continue;
    seen.add(key); out.push(it);
  }
  out.sort((a, b) => (b.date || 0) - (a.date || 0));
  return out.slice(0, limit);
}

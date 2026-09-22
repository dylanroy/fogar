import type { GroundingSettings, Message } from './llm/types';

export interface Source { title: string; url: string; snippet: string; /** Who supplied it, for attribution. */ via?: string }

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
const TAVILY_URL = 'https://api.tavily.com/search';
const DDG_URL = 'https://api.duckduckgo.com/';
const wikiUrl = (lang: string) => `https://${lang}.wikipedia.org/w/api.php`;

export function groundingApiUrl(g: GroundingSettings): string {
  if (g.endpoint) return g.endpoint;
  return g.provider === 'tavily' ? TAVILY_URL : g.provider === 'free' ? DDG_URL : BRAVE_URL;
}

/** The free tier needs no key; the paid providers need one. */
export function groundingConfigured(g: GroundingSettings): boolean {
  if (g.provider === 'free') return true;
  return g.provider !== 'none' && g.apiKey.trim().length > 0;
}

export const needsKey = (p: GroundingSettings['provider']) => p === 'brave' || p === 'tavily';

/** "Who is the US president?" → "the US president". Instant-answer lookups want the thing, not the question. */
export function entityQuery(question: string): string {
  const stripped = question
    .trim()
    .replace(/^\s*(?:(?:who|what|when|where|why|how)(?:'s|’s|\s+(?:is|are|was|were|did|does|do|has|have))?\s+|tell me about\s+|explain\s+|define\s+|describe\s+|look up\s+|search(?:\s+for)?\s+)/i, '')
    .replace(/[?.!\s]+$/g, '')
    .trim();
  return stripped || question.trim();
}

const wikiLang = () => {
  const l = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en').split('-')[0]!.toLowerCase();
  return /^[a-z]{2,3}$/.test(l) ? l : 'en';
};

/**
 * Keyless grounding from two official, CORS-open APIs: DuckDuckGo's Instant Answer API (an abstract and related
 * topics, usually sourced from Wikipedia) and Wikipedia's search with intro extracts. Good for people, places,
 * terms, and well-known topics; not for news or niche sites. Either source may fail without sinking the other.
 */
async function searchFree(query: string, g: GroundingSettings, signal?: AbortSignal): Promise<Source[]> {
  const ddgUrl = g.endpoint ? `${g.endpoint}/ddg` : DDG_URL;
  const wUrl = g.endpoint ? `${g.endpoint}/wiki` : wikiUrl(wikiLang());
  const ddg = fetch(`${ddgUrl}?${new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1' })}`, { signal })
    .then((r) => { if (!r.ok) throw new Error(`DuckDuckGo returned ${r.status}`); return r.json(); });
  const wiki = fetch(`${wUrl}?${new URLSearchParams({ action: 'query', format: 'json', origin: '*', generator: 'search', gsrsearch: query, gsrlimit: '4', gsrnamespace: '0', prop: 'extracts|info', exintro: '1', explaintext: '1', exlimit: 'max', exchars: '700', inprop: 'url' })}`, { signal })
    .then((r) => { if (!r.ok) throw new Error(`Wikipedia returned ${r.status}`); return r.json(); });
  const [d, w] = await Promise.allSettled([ddg, wiki]);
  if (d.status === 'rejected' && w.status === 'rejected') throw new Error(`${d.reason?.message ?? d.reason}; ${w.reason?.message ?? w.reason}`);
  if (d.status === 'rejected') console.warn('[fogar] grounding: DuckDuckGo failed, using Wikipedia only:', d.reason?.message ?? d.reason);
  if (w.status === 'rejected') console.warn('[fogar] grounding: Wikipedia failed, using DuckDuckGo only:', w.reason?.message ?? w.reason);

  const byUrl = new Map<string, Source>();
  const add = (s: Source) => {
    if (!s.url || !s.snippet.trim()) return;
    const prev = byUrl.get(s.url);
    if (prev) { if (s.snippet.length > prev.snippet.length) prev.snippet = s.snippet; return; }
    byUrl.set(s.url, s);
  };
  const related: Source[] = [];
  if (d.status === 'fulfilled') {
    const a = d.value ?? {};
    if (a.AbstractText) add({ title: a.Heading || query, url: a.AbstractURL || '', snippet: String(a.AbstractText).slice(0, 700), via: `DuckDuckGo · ${a.AbstractSource || 'instant answer'}` });
    const flat: any[] = [];
    for (const t of a.RelatedTopics ?? []) { if (t?.Topics) flat.push(...t.Topics); else flat.push(t); }
    for (const t of flat) {
      if (!t?.Text || !t?.FirstURL || /duckduckgo\.com\/c\//.test(t.FirstURL)) continue; // categories are not sources
      related.push({ title: String(t.Text).split(' - ')[0]!.slice(0, 80), url: t.FirstURL, snippet: String(t.Text).slice(0, 400), via: 'DuckDuckGo' });
    }
  }
  if (w.status === 'fulfilled') {
    const pages = Object.values(w.value?.query?.pages ?? {}) as any[];
    pages.sort((x, y) => (x.index ?? 99) - (y.index ?? 99));
    for (const p of pages) if (p.extract) add({ title: p.title, url: p.fullurl || `https://${wikiLang()}.wikipedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, '_'))}`, snippet: String(p.extract).slice(0, 700), via: 'Wikipedia' });
  }
  for (const r of related) { if (byUrl.size >= 5) break; add(r); }
  return [...byUrl.values()].slice(0, 5);
}

/** Fetch a handful of web results. Only ever called when the user ticked "Search the web first". */
export async function searchWeb(query: string, g: GroundingSettings, signal?: AbortSignal): Promise<Source[]> {
  if (g.provider === 'free') return searchFree(entityQuery(query), g, signal);
  const url = groundingApiUrl(g);
  if (g.provider === 'tavily') {
    const res = await fetch(url, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${g.apiKey}` },
      body: JSON.stringify({ query, max_results: 5, include_answer: false }),
    });
    if (!res.ok) throw new Error(`Tavily returned ${res.status}`);
    const data = await res.json();
    return (data.results ?? []).slice(0, 5).map((r: any) => ({ title: r.title ?? r.url, url: r.url, snippet: String(r.content ?? '').slice(0, 400) }));
  }
  const res = await fetch(`${url}?q=${encodeURIComponent(query)}&count=5&text_decorations=false`, {
    signal,
    headers: { Accept: 'application/json', 'X-Subscription-Token': g.apiKey },
  });
  if (!res.ok) throw new Error(`Brave Search returned ${res.status}`);
  const data = await res.json();
  return (data.web?.results ?? []).slice(0, 5).map((r: any) => ({ title: r.title ?? r.url, url: r.url, snippet: String(r.description ?? '').slice(0, 400) }));
}

/** Small models answer well from text they are handed. Put the sources in front of the question, numbered, and ask for citations. */
export function groundedMessages(system: string, question: string, sources: Source[], history: Message[] = []): Message[] {
  const list = sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}`).join('\n\n');
  return [
    {
      role: 'system',
      content: `${system}\n\nAnswer using only the numbered sources below. Cite them inline like [1]. If the sources do not contain the answer, say you could not find it in the results.`,
    },
    ...history,
    { role: 'user', content: `Sources:\n\n${list}\n\nQuestion: ${question}` },
  ];
}

import type { GroundingSettings, Message } from './llm/types';

export interface Source { title: string; url: string; snippet: string }

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
const TAVILY_URL = 'https://api.tavily.com/search';

export function groundingApiUrl(g: GroundingSettings): string {
  return g.endpoint ?? (g.provider === 'tavily' ? TAVILY_URL : BRAVE_URL);
}

export function groundingConfigured(g: GroundingSettings): boolean {
  return g.provider !== 'none' && g.apiKey.trim().length > 0;
}

/** Fetch a handful of web results. Only ever called when the user turned grounding on and supplied a key. */
export async function searchWeb(query: string, g: GroundingSettings, signal?: AbortSignal): Promise<Source[]> {
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

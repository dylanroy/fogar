import { bookmarkIndex, type BookmarkHit } from './bookmarks';
import type { Message, Provider } from './llm/types';

/** Questions that are about the user's bookmarks rather than about the world. */
export const BOOKMARK_INTENT =
  /(\b(find|list|show|search|look|get|which|what|any|all|open|do i have)\b[\s\S]*\bbookmark(s|ed)?\b)|(\bbookmark(s|ed)?\b[\s\S]*\b(about|for|related|that|with|on|from|like)\b)/i;

/** "Find and list bookmarks that are job postings" → "job postings". */
export function bookmarkCriterion(question: string): string {
  return question
    .replace(/\b(please|can you|could you|would you|i want to|i need to|help me|do i have)\b/gi, ' ')
    .replace(/\b(find|list|show|search( for)?|look for|get|give me|open|which of|what|and)\b/gi, ' ')
    .replace(/\b(me|my|all|the|any|of|in|from|are|is|look like|that|which|bookmarks?|bookmarked|saved|links?|pages?|sites?|related to|about)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\W+|\W+$/g, '')
    .trim();
}

export async function allBookmarks(): Promise<BookmarkHit[]> {
  return (await bookmarkIndex()).map((b) => ({ id: b.id, title: b.title, url: b.url, path: b.path }));
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'are', 'about', 'from', 'this', 'into', 'have', 'some', 'like', 'where', 'when']);
const stem = (w: string) => w.replace(/ings?$/, '').replace(/([^s])s$/, '$1');
const keywords = (criterion: string) =>
  criterion.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem).filter((w) => w.length >= 3);
const host = (url: string) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };

const CLASSIFY_SYSTEM =
  'You sort bookmarks. Given a topic and a numbered list of bookmarks, reply with only the numbers of the bookmarks that are about the topic or clearly useful to someone interested in it, separated by commas. If none match, reply NONE. No other words.';
const EXPAND_SYSTEM =
  'You expand search terms. Reply with a comma-separated list of lowercase single words only: synonyms, related words, and well-known website names someone would find in the titles or web addresses of bookmarks on the topic. No explanations, no sentences.';

export interface BookmarkFindResult {
  criterion: string;
  /** The words actually looked for, expanded by the model. */
  terms: string[];
  hits: BookmarkHit[];
  keywordHits: number;
  modelHits: number;
  total: number;
  scanned: number;
  /** True when the criterion was empty and the newest bookmarks are shown instead. */
  listedAll: boolean;
}

const BATCH = 25;
const MAX_MODEL_ITEMS = 500;

async function collect(provider: Provider, messages: Message[], signal: AbortSignal, maxTokens: number): Promise<string> {
  let reply = '';
  for await (const t of provider.ask(messages, signal, { maxTokens, temperature: 0 })) { reply += t; if (reply.length > 600) break; }
  return reply;
}

/** Ask the model for related words once, so "cooking" also finds "risotto", "seriouseats", and "kitchen". */
async function expandTerms(criterion: string, provider: Provider, signal: AbortSignal): Promise<string[]> {
  const base = keywords(criterion);
  const terms = new Set<string>(base);
  for (const w of criterion.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3) terms.add(w);
  try {
    const reply = await collect(provider, [{ role: 'system', content: EXPAND_SYSTEM }, { role: 'user', content: `Topic: ${criterion}\nWords:` }], signal, 80);
    for (const raw of reply.toLowerCase().split(/[,\n;]+/)) {
      const w = raw.trim().replace(/^[^a-z0-9]+|[^a-z0-9.]+$/g, '').replace(/\.(com|org|net|io)$/, '');
      if (w.length >= 3 && w.length <= 24 && !/\s/.test(w) && !STOP.has(w)) terms.add(stem(w));
      if (terms.size >= 20) break;
    }
  } catch (err) {
    if (signal.aborted) throw err; // otherwise the keyword floor still works without expansion
  }
  return [...terms];
}

/**
 * Three passes. Expansion turns the topic into words a small model can be trusted to produce. The keyword pass
 * over title, address, and folder is deterministic and gives a floor no model can take away. The classification
 * pass reads the list in batches and adds what words alone miss. Results: matched by both first, then keywords,
 * then the model's own picks.
 */
export async function findBookmarks(
  question: string,
  provider: Provider,
  signal: AbortSignal,
  onProgress: (scanned: number, total: number, phase: 'expanding' | 'scanning') => void,
): Promise<BookmarkFindResult> {
  const criterion = bookmarkCriterion(question);
  const all = await allBookmarks();
  if (!criterion) return { criterion, terms: [], hits: all.slice(-20).reverse(), keywordHits: 0, modelHits: 0, total: all.length, scanned: all.length, listedAll: true };

  onProgress(0, all.length, 'expanding');
  const terms = await expandTerms(criterion, provider, signal);
  const original = new Set(keywords(criterion));
  const keywordScore = new Map<string, number>();
  for (const b of all) {
    const hay = `${b.title} ${b.url} ${b.path ?? ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += original.has(t) ? 3 : 1;
    if (score) keywordScore.set(b.id, score);
  }

  const modelPicks = new Set<string>();
  // Over 500 bookmarks the model only re-reads the keyword candidates; below that it reads everything.
  const pool = all.length > MAX_MODEL_ITEMS ? all.filter((b) => keywordScore.has(b.id)) : all;
  let scanned = 0;
  for (let i = 0; i < pool.length; i += BATCH) {
    if (signal.aborted) break;
    const batch = pool.slice(i, i + BATCH);
    const list = batch.map((b, j) => `${j + 1}. ${b.title.slice(0, 70)} (${host(b.url)})${b.path ? ` [${b.path.slice(0, 40)}]` : ''}`).join('\n');
    let reply = '';
    try {
      reply = await collect(provider, [{ role: 'system', content: CLASSIFY_SYSTEM }, { role: 'user', content: `Topic: ${criterion} (related: ${terms.slice(0, 8).join(', ')})\n\n${list}` }], signal, 60);
    } catch (err) {
      if (signal.aborted) break;
      throw err;
    }
    if (!/\bnone\b/i.test(reply)) {
      for (const m of reply.matchAll(/\d+/g)) { const n = Number(m[0]); if (n >= 1 && n <= batch.length) modelPicks.add(batch[n - 1]!.id); }
    }
    scanned += batch.length;
    onProgress(scanned, pool.length, 'scanning');
  }

  const rank = (b: BookmarkHit) => (keywordScore.get(b.id) ?? 0) * 10 + (modelPicks.has(b.id) ? 5 : 0);
  const hits = all.filter((b) => keywordScore.has(b.id) || modelPicks.has(b.id)).sort((a, b) => rank(b) - rank(a));
  return { criterion, terms, hits, keywordHits: keywordScore.size, modelHits: modelPicks.size, total: all.length, scanned, listedAll: false };
}

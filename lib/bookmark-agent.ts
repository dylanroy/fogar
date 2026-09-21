import { browser } from 'wxt/browser';
import type { BookmarkHit } from './bookmarks';
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
  const out: BookmarkHit[] = [];
  const walk = (nodes: Array<{ id: string; title: string; url?: string; children?: any[] }>) => {
    for (const n of nodes) {
      if (n.url && !n.url.startsWith('javascript:')) out.push({ id: n.id, title: n.title || n.url, url: n.url });
      if (n.children) walk(n.children);
    }
  };
  walk((await browser.bookmarks.getTree()) as any);
  return out;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'are', 'about', 'from', 'this', 'into', 'have', 'some', 'like', 'where', 'when']);
const stem = (w: string) => w.replace(/ings?$/, '').replace(/([^s])s$/, '$1');
const keywords = (criterion: string) =>
  criterion.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem).filter((w) => w.length >= 3);
const host = (url: string) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };

const CLASSIFY_SYSTEM =
  'You sort bookmarks. Given a criterion and a numbered list of bookmarks, reply with only the numbers of the bookmarks that match the criterion, separated by commas. If none match, reply NONE. No other words.';

export interface BookmarkFindResult {
  criterion: string;
  hits: BookmarkHit[];
  total: number;
  scanned: number;
  /** True when the criterion was empty and the newest bookmarks are shown instead. */
  listedAll: boolean;
}

const BATCH = 40;
const MAX_BATCHES = 20;

/**
 * Two passes. Keywords catch the obvious matches instantly; the model then reads the list in batches and picks
 * the ones a keyword would miss ("Senior Engineer at Acme" is a job posting with no "job" in it).
 */
export async function findBookmarks(
  question: string,
  provider: Provider,
  signal: AbortSignal,
  onProgress: (scanned: number, total: number) => void,
): Promise<BookmarkFindResult> {
  const criterion = bookmarkCriterion(question);
  const all = await allBookmarks();
  if (!criterion) return { criterion, hits: all.slice(-20).reverse(), total: all.length, scanned: all.length, listedAll: true };

  const kws = keywords(criterion);
  const hitIds = new Set<string>();
  for (const b of all) {
    const hay = `${b.title} ${b.url}`.toLowerCase();
    if (kws.some((k) => hay.includes(k))) hitIds.add(b.id);
  }

  const batches: BookmarkHit[][] = [];
  for (let i = 0; i < all.length && batches.length < MAX_BATCHES; i += BATCH) batches.push(all.slice(i, i + BATCH));
  let scanned = 0;
  for (const batch of batches) {
    if (signal.aborted) break;
    const list = batch.map((b, i) => `${i + 1}. ${b.title.slice(0, 70)} (${host(b.url)})`).join('\n');
    const messages: Message[] = [{ role: 'system', content: CLASSIFY_SYSTEM }, { role: 'user', content: `Criterion: ${criterion}\n\n${list}` }];
    let reply = '';
    try {
      for await (const t of provider.ask(messages, signal, { maxTokens: 80 })) { reply += t; if (reply.length > 300) break; }
    } catch (err) {
      if (signal.aborted) break;
      throw err;
    }
    if (!/\bnone\b/i.test(reply)) {
      for (const m of reply.matchAll(/\d+/g)) { const n = Number(m[0]); if (n >= 1 && n <= batch.length) hitIds.add(batch[n - 1]!.id); }
    }
    scanned += batch.length;
    onProgress(scanned, all.length);
  }
  return { criterion, hits: all.filter((b) => hitIds.has(b.id)), total: all.length, scanned, listedAll: false };
}

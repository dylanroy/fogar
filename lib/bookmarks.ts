import { browser } from 'wxt/browser';

export interface BookmarkHit { id: string; title: string; url: string; path?: string }

interface Indexed extends BookmarkHit {
  path: string;
  t: string;       // title, lowercased
  host: string;    // hostname without www
  urlRest: string; // path + query, lowercased
  p: string;       // folder path, lowercased
  dateAdded: number;
}

export const bookmarksAvailable = () => typeof browser.bookmarks?.getTree === 'function';

/**
 * The whole tree, flattened once with folder paths, and dropped whenever bookmarks change. Chrome's own
 * bookmarks.search() only does whole-word prefix matches on title and URL; ranking our own index lets typos,
 * folder names, and partial words work too.
 */
let index: Indexed[] | null = null;
let watching = false;

export async function bookmarkIndex(): Promise<Indexed[]> {
  if (index) return index;
  const out: Indexed[] = [];
  const walk = (nodes: any[], trail: string[]) => {
    for (const n of nodes) {
      if (n.url) {
        if (n.url.startsWith('javascript:')) continue;
        let host = ''; let urlRest = '';
        try { const u = new URL(n.url); host = u.host.replace(/^www\./, ''); urlRest = (u.pathname + u.search).toLowerCase(); } catch { /* keep blanks */ }
        const path = trail.join(' › ');
        out.push({ id: n.id, title: n.title || n.url, url: n.url, path, t: (n.title || '').toLowerCase(), host: host.toLowerCase(), urlRest, p: path.toLowerCase(), dateAdded: n.dateAdded ?? 0 });
      }
      if (n.children) walk(n.children, n.title && n.parentId !== undefined && n.parentId !== '0' ? [...trail, n.title] : trail);
    }
  };
  walk(await browser.bookmarks.getTree(), []);
  index = out;
  if (!watching) {
    watching = true;
    const drop = () => { index = null; };
    for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onImportEnded'] as const) (browser.bookmarks as any)[ev]?.addListener(drop);
  }
  return out;
}

/** True when `needle` appears in order inside `hay` (f-g-r in "fogar"). Cheap typo tolerance for short tokens. */
function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) { if (ch === needle[i]) i++; if (i === needle.length) return true; }
  return i === needle.length;
}

const wordStart = (hay: string, tok: string) => hay.startsWith(tok) || hay.includes(` ${tok}`) || hay.includes(`/${tok}`) || hay.includes(`-${tok}`) || hay.includes(`.${tok}`) || hay.includes(`_${tok}`);

/** Ranked search. Every query token must match somewhere; title matches outrank URL and folder matches. */
export async function searchBookmarks(query: string, limit = 8): Promise<BookmarkHit[]> {
  if (!bookmarksAvailable()) return [];
  const tokens = query.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t.length >= 2);
  if (!tokens.length || tokens.length > 6) return []; // six words and up is a question, not a lookup
  const all = await bookmarkIndex();
  const scored: Array<[number, Indexed]> = [];
  for (const b of all) {
    let score = 0;
    for (const tok of tokens) {
      let s = 0;
      if (b.t.startsWith(tok)) s = 12;
      else if (wordStart(b.t, tok)) s = 10;
      else if (b.t.includes(tok)) s = 6;
      else if (b.host.startsWith(tok) || wordStart(b.host, tok)) s = 7;
      else if (b.host.includes(tok)) s = 4;
      else if (wordStart(b.p, tok)) s = 5;
      else if (b.p.includes(tok)) s = 3;
      else if (b.urlRest.includes(tok)) s = 2;
      else if (tok.length >= 4 && subsequence(tok, b.t)) s = 2; // typo tolerance, title only
      if (!s) { score = 0; break; }
      score += s;
    }
    if (!score) continue;
    if (b.dateAdded && Date.now() - b.dateAdded < 30 * 86400e3) score += 1;
    if (b.t.length && b.t.length < 40) score += 0.5; // short titles are usually the site itself, not an article
    scored.push([score, b]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].t.length - b[1].t.length);
  return scored.slice(0, limit).map(([, b]) => ({ id: b.id, title: b.title, url: b.url, path: b.path }));
}

export async function removeBookmark(id: string): Promise<void> {
  await browser.bookmarks.remove(id);
  index = null;
}

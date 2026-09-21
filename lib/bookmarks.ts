import { browser } from 'wxt/browser';

export interface BookmarkHit { id: string; title: string; url: string }

export const bookmarksAvailable = () => typeof browser.bookmarks?.search === 'function';

export async function searchBookmarks(query: string, limit = 6): Promise<BookmarkHit[]> {
  if (!bookmarksAvailable()) return [];
  const q = query.trim();
  if (q.length < 2) return [];
  const results = await browser.bookmarks.search(q);
  return results
    .filter((b) => !!b.url)
    .slice(0, limit)
    .map((b) => ({ id: b.id, title: b.title || b.url!, url: b.url! }));
}

export async function removeBookmark(id: string): Promise<void> {
  await browser.bookmarks.remove(id);
}

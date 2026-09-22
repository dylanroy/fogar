import { browser } from 'wxt/browser';
import { getItem, setItem, uid } from './store';

export interface SavedTab { id: string; url: string; title: string; pinned?: boolean }
export interface SavedWindow { id: string; tabs: SavedTab[] }
export interface Session { id: string; name: string; savedAt: number; windows: SavedWindow[] }

export const SESSIONS_KEY = 'fogar.sessions';
export const loadSessions = () => getItem<Session[]>(SESSIONS_KEY, []);
export const saveSessions = (s: Session[]) => setItem(SESSIONS_KEY, s);

/**
 * Reading tab titles and addresses across windows needs Chrome's `tabs` permission, which Chrome labels
 * "Read your browsing history" at install. It is optional and asked for only when the Sessions widget is added,
 * so everyone else keeps the quiet permission list.
 */
export async function hasTabsPermission(): Promise<boolean> {
  try { return await browser.permissions.contains({ permissions: ['tabs'] }); } catch { return false; }
}
export async function requestTabsPermission(): Promise<boolean> {
  try { return await browser.permissions.request({ permissions: ['tabs'] }); } catch { return false; }
}

const SKIP = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;
export const isSaveable = (url?: string): url is string => !!url && !SKIP.test(url);
export const hostOf = (url: string) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };

export interface OpenWindow { id: number; current: boolean; tabs: SavedTab[]; skipped: number; /** Title of the tab on top, the way people recognise a window. */ activeTitle?: string }

/** Every normal, non-incognito window with its saveable tabs. The new tab page itself and other browser pages are skipped. */
export async function openWindows(): Promise<{ windows: OpenWindow[]; totalWindows: number; totalTabs: number }> {
  const wins = await browser.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const cur = (await browser.windows.getCurrent()).id;
  const windows: OpenWindow[] = [];
  let totalTabs = 0;
  for (const w of wins) {
    if (w.incognito) continue;
    const all = w.tabs ?? [];
    const tabs = all.filter((t) => isSaveable(t.url)).map((t) => ({ id: uid(), url: t.url!, title: t.title || t.url!, pinned: t.pinned || undefined }));
    totalTabs += tabs.length;
    const active = all.find((t) => t.active && isSaveable(t.url));
    windows.push({ id: w.id!, current: w.id === cur, tabs, skipped: all.length - tabs.length, activeTitle: active?.title || undefined });
  }
  return { windows, totalWindows: windows.length, totalTabs };
}

/** Bring a window to the front. The list of open windows doubles as a window switcher. */
export async function focusWindow(id: number): Promise<void> {
  try { await browser.windows.update(id, { focused: true }); } catch { /* window closed meanwhile */ }
}

/** Collapse duplicate addresses inside one session. Returns how many were dropped. */
function dedupe(windows: SavedWindow[]): number {
  const seen = new Set<string>(); let removed = 0;
  for (const w of windows) w.tabs = w.tabs.filter((t) => { if (seen.has(t.url)) { removed++; return false; } seen.add(t.url); return true; });
  return removed;
}

export function topHosts(tabs: SavedTab[], n = 3): string[] {
  const counts = new Map<string, number>();
  for (const t of tabs) { const h = hostOf(t.url); if (h) counts.set(h, (counts.get(h) ?? 0) + 1); }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([h]) => h);
}

export function autoName(windows: SavedWindow[], when = Date.now()): string {
  const d = new Date(when);
  const day = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const hosts = topHosts(windows.flatMap((w) => w.tabs));
  return `${day} ${time}${hosts.length ? ` · ${hosts.join(', ')}` : ''}`;
}

export const tabCount = (s: Session) => s.windows.reduce((n, w) => n + w.tabs.length, 0);

/** Save some open windows as one session. Nothing is closed here. */
export async function saveSession(windows: OpenWindow[], name?: string): Promise<{ session: Session; duplicates: number } | null> {
  const saved: SavedWindow[] = windows.map((w) => ({ id: uid(), tabs: w.tabs.map((t) => ({ ...t })) }));
  const duplicates = dedupe(saved);
  const kept = saved.filter((w) => w.tabs.length);
  if (!kept.length) return null;
  const session: Session = { id: uid(), name: name?.trim() || autoName(kept), savedAt: Date.now(), windows: kept };
  const all = await loadSessions();
  all.unshift(session);
  await saveSessions(all);
  return { session, duplicates };
}

/** Close windows, the current one last, so the page doing the saving survives until the save is on disk. */
export async function closeWindows(ids: number[]): Promise<void> {
  const cur = (await browser.windows.getCurrent()).id;
  for (const id of ids.filter((i) => i !== cur)) { try { await browser.windows.remove(id); } catch { /* already gone */ } }
  if (cur !== undefined && ids.includes(cur)) { try { await browser.windows.remove(cur); } catch { /* gone */ } }
}

/** Reopen a saved window. Tabs after the first are created discarded, so fifteen tabs do not load fifteen pages. */
export async function restoreWindow(w: SavedWindow): Promise<void> {
  if (!w.tabs.length) return;
  const created = await browser.windows.create({ url: w.tabs[0]!.url, focused: true });
  const windowId = created?.id;
  if (windowId === undefined) return;
  for (const t of w.tabs.slice(1)) {
    try {
      const tab = await browser.tabs.create({ windowId, url: t.url, active: false, pinned: t.pinned });
      if (tab.id !== undefined) { try { await browser.tabs.discard(tab.id); } catch { /* it stays loaded; fine */ } }
    } catch { /* an address Chrome refuses to open; skip it */ }
  }
}

export async function restoreSession(s: Session): Promise<void> {
  for (const w of s.windows) await restoreWindow(w);
}

async function update(fn: (all: Session[]) => void): Promise<Session[]> {
  const all = await loadSessions(); fn(all); await saveSessions(all); return all;
}
export const deleteSession = (id: string) => update((all) => { const i = all.findIndex((s) => s.id === id); if (i >= 0) all.splice(i, 1); });
export const renameSession = (id: string, name: string) => update((all) => { const s = all.find((x) => x.id === id); if (s && name.trim()) s.name = name.trim(); });
export const removeTab = (sessionId: string, tabId: string) => update((all) => {
  const s = all.find((x) => x.id === sessionId); if (!s) return;
  for (const w of s.windows) w.tabs = w.tabs.filter((t) => t.id !== tabId);
  s.windows = s.windows.filter((w) => w.tabs.length);
  if (!s.windows.length) all.splice(all.indexOf(s), 1);
});

/** Promoted tabs go into a folder named after the session under "Other bookmarks". Already-present addresses are skipped. */
async function otherBookmarksId(): Promise<string> {
  const kids = (await browser.bookmarks.getTree())[0]?.children ?? [];
  return (kids[1] ?? kids[0])!.id;
}
export async function bookmarkTabs(session: Session, tabs: SavedTab[]): Promise<{ folderId: string; added: number; skipped: number }> {
  const parent = await otherBookmarksId();
  const existing = (await browser.bookmarks.getChildren(parent)).find((n) => !n.url && n.title === session.name);
  const folder = existing ?? await browser.bookmarks.create({ parentId: parent, title: session.name });
  const have = new Set((await browser.bookmarks.getChildren(folder.id)).map((n) => n.url));
  let added = 0; let skipped = 0;
  for (const t of tabs) {
    if (have.has(t.url)) { skipped++; continue; }
    await browser.bookmarks.create({ parentId: folder.id, title: t.title, url: t.url }); have.add(t.url); added++;
  }
  return { folderId: folder.id, added, skipped };
}
export const bookmarkSession = (s: Session) => bookmarkTabs(s, s.windows.flatMap((w) => w.tabs));

/** Ranked search across every saved tab: title first, then site, session name, address. */
export interface TabHit { tab: SavedTab; session: Session; score: number }
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this']);
export async function searchSavedTabs(query: string, limit = 6): Promise<TabHit[]> {
  const tokens = query.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t.length >= 2 && !STOP.has(t));
  if (!tokens.length || tokens.length > 6) return [];
  const hits: TabHit[] = [];
  for (const s of await loadSessions()) {
    const sname = s.name.toLowerCase();
    for (const w of s.windows) for (const t of w.tabs) {
      const title = t.title.toLowerCase(); const host = hostOf(t.url).toLowerCase(); const url = t.url.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        let sc = 0;
        if (title.startsWith(tok)) sc = 12; else if (title.includes(` ${tok}`) || title.includes(`-${tok}`) || title.includes(`:${tok}`)) sc = 10; else if (title.includes(tok)) sc = 6;
        else if (host.startsWith(tok) || host.includes(`.${tok}`)) sc = 7; else if (host.includes(tok)) sc = 4;
        else if (sname.includes(tok)) sc = 3; else if (url.includes(tok)) sc = 2;
        if (!sc) { score = 0; break; }
        score += sc;
      }
      if (score) hits.push({ tab: t, session: s, score });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.session.savedAt - a.session.savedAt);
  return hits.slice(0, limit);
}

// ---------- export ----------
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';

/** A readable list of every link, one heading per session. */
export function sessionsToMarkdown(list: Session[]): string {
  const out: string[] = ['# Fogar sessions', '', `Exported ${new Date().toLocaleString()}.`, ''];
  for (const s of list) {
    out.push(`## ${s.name}`, '', `${tabCount(s)} tab${tabCount(s) === 1 ? '' : 's'} · saved ${new Date(s.savedAt).toLocaleString()}`, '');
    s.windows.forEach((w, i) => {
      if (s.windows.length > 1) out.push(`### Window ${i + 1}`, '');
      for (const t of w.tabs) out.push(`- [${t.title.replace(/[\[\]]/g, ' ').trim() || t.url}](${t.url})`);
      out.push('');
    });
  }
  return out.join('\n');
}

/** The Netscape bookmark file format, which every browser's bookmark manager imports. One folder per session. */
export function sessionsToBookmarksHtml(list: Session[]): string {
  const ts = (ms: number) => Math.floor(ms / 1000);
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>',
  ];
  for (const s of list) {
    lines.push(`    <DT><H3 ADD_DATE="${ts(s.savedAt)}" LAST_MODIFIED="${ts(Date.now())}">${esc(s.name)}</H3>`, '    <DL><p>');
    for (const w of s.windows) for (const t of w.tabs) lines.push(`        <DT><A HREF="${esc(t.url)}" ADD_DATE="${ts(s.savedAt)}">${esc(t.title)}</A>`);
    lines.push('    </DL><p>');
  }
  lines.push('</DL><p>');
  return lines.join('\n') + '\n';
}

/** The backup shape, sessions only, so "Restore from a backup" brings it back into Fogar. */
export function sessionsToFogarFile(list: Session[]): string {
  return JSON.stringify({ fogar: 1, exportedAt: new Date().toISOString(), sessions: list }, null, 2);
}

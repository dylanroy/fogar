/**
 * The web app's stand-in for `wxt/browser`. vite.web.config.ts aliases that import here, so the page runs unchanged as
 * a plain web app at app.fogar.ai. Only what the page uses is implemented: local storage over IndexedDB with change
 * events (this tab and the others), session storage, asset URLs, permission checks, tabs.create, and notifications
 * through the web API. Everything extension-only (bookmarks, tabs, windows, identity, alarms) is left undefined, and
 * the page's own checks hide those features; see lib/platform.ts.
 */
type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type ChangeListener = (changes: Changes, area: string) => void;

const DB = 'fogar';
const STORE = 'kv';
let opening: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
      req.onerror = () => { opening = null; reject(req.error ?? new Error('IndexedDB is not available')); };
    });
  }
  return opening;
}
const done = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const committed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('transaction aborted')); });
/** chrome.storage keeps JSON, not live objects: no undefined, no Dates, no class instances. Same here, so both builds read the same data. */
const plain = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const listeners = new Set<ChangeListener>();
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('fogar.storage') : null;
channel?.addEventListener('message', (e: MessageEvent<Changes>) => { for (const cb of listeners) cb(e.data, 'local'); });
/** Like the extension, every context hears a change, the writer included. */
function emit(changes: Changes): void {
  for (const cb of listeners) { try { cb(changes, 'local'); } catch (err) { console.error('[fogar] storage listener failed', err); } }
  channel?.postMessage(changes);
}

const local = {
  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const store = (await db()).transaction(STORE, 'readonly').objectStore(STORE);
    const out: Record<string, unknown> = {};
    if (keys === null || keys === undefined) {
      const [ks, vs] = await Promise.all([done(store.getAllKeys()), done(store.getAll())]);
      ks.forEach((k, i) => { out[String(k)] = vs[i]; });
      return out;
    }
    const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const defaults: Record<string, unknown> = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
    const values = await Promise.all(wanted.map((k) => done(store.get(k))));
    wanted.forEach((k, i) => { const v = values[i] ?? defaults[k]; if (v !== undefined) out[k] = v; });
    return out;
  },
  async set(items: Record<string, unknown>): Promise<void> {
    const tx = (await db()).transaction(STORE, 'readwrite'); const store = tx.objectStore(STORE);
    const changes: Changes = {};
    for (const [k, v] of Object.entries(items)) {
      const value = plain(v);
      changes[k] = { oldValue: await done(store.get(k)), newValue: value };
      store.put(value, k);
    }
    await committed(tx);
    emit(changes);
  },
  async remove(keys: string | string[]): Promise<void> {
    const tx = (await db()).transaction(STORE, 'readwrite'); const store = tx.objectStore(STORE);
    const changes: Changes = {};
    for (const k of typeof keys === 'string' ? [keys] : keys) { changes[k] = { oldValue: await done(store.get(k)) }; store.delete(k); }
    await committed(tx);
    emit(changes);
  },
  async clear(): Promise<void> {
    const tx = (await db()).transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); await committed(tx);
  },
};

/** Session storage: gone when the tab closes, like chrome.storage.session. Only the right-click hand-off uses it, and never on the web. */
const SESSION_PREFIX = 'fogar.session:';
const session = {
  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of typeof keys === 'string' ? [keys] : keys) { const raw = sessionStorage.getItem(SESSION_PREFIX + k); if (raw !== null) out[k] = JSON.parse(raw); }
    return out;
  },
  async set(items: Record<string, unknown>): Promise<void> { for (const [k, v] of Object.entries(items)) sessionStorage.setItem(SESSION_PREFIX + k, JSON.stringify(v)); },
  async remove(keys: string | string[]): Promise<void> { for (const k of typeof keys === 'string' ? [keys] : keys) sessionStorage.removeItem(SESSION_PREFIX + k); },
};

const onChanged = {
  addListener: (cb: ChangeListener) => { listeners.add(cb); },
  removeListener: (cb: ChangeListener) => { listeners.delete(cb); },
  hasListener: (cb: ChangeListener) => listeners.has(cb),
};

const runtime = {
  id: 'fogar-web',
  /** Extension-relative paths become origin-relative: the built files sit at the root of app.fogar.ai. */
  getURL: (path: string): string => new URL(path.startsWith('/') ? path : `/${path}`, location.origin).href,
  async sendMessage(_message: unknown): Promise<never> { throw new Error('The web app has no background worker.'); },
};

/** A web page has no permission model for origins: CORS decides at request time. Named extension permissions do not exist here. */
const permissions = {
  async contains(query: { origins?: string[]; permissions?: string[] }): Promise<boolean> { return !query.permissions?.length; },
  async request(query: { origins?: string[]; permissions?: string[] }): Promise<boolean> { return !query.permissions?.length; },
};

const tabs = {
  async create(opts: { url?: string }): Promise<Record<string, never>> { if (opts.url) window.open(opts.url, '_blank', 'noopener'); return {}; },
};

/**
 * Web notifications, shown through the service worker when there is one (Android's Chrome allows no other way) and
 * the plain constructor otherwise. Permission is asked for on the first attempt, which the page only makes from a click.
 */
const notifications = {
  async getPermissionLevel(): Promise<'granted' | 'denied'> {
    return typeof Notification !== 'undefined' && Notification.permission !== 'denied' ? 'granted' : 'denied';
  },
  async create(id: string, opts: { title: string; message: string; iconUrl?: string }): Promise<string> {
    if (typeof Notification === 'undefined') throw new Error('This browser has no notifications.');
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') throw new Error('Notifications are blocked for this site.');
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(opts.title, { body: opts.message, icon: opts.iconUrl, tag: id });
    else new Notification(opts.title, { body: opts.message, icon: opts.iconUrl, tag: id });
    return id;
  },
};

export const browser = { storage: { local, session, onChanged }, runtime, permissions, tabs, notifications };
export default browser;

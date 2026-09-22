import { REMINDERS_KEY, loadReminders, saveReminders, type Reminder } from '@/lib/reminders';
import { CTX_KEY, extractPageContext, type PageContext } from '@/lib/page-context';

const ALARM_PREFIX = 'fogar-reminder:';

async function notify(reminder: Reminder) {
  await browser.notifications.create(ALARM_PREFIX + reminder.id, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title: 'Fogar reminder',
    message: reminder.label,
    priority: 2,
    requireInteraction: true, // a reminder should wait to be seen, not vanish after five seconds
  });
  const all = await loadReminders();
  await saveReminders(all.map((r) => (r.id === reminder.id ? { ...r, fired: true } : r)));
}

/**
 * Storage is the source of truth. Whenever the reminders list changes, or the worker starts, make the alarm
 * set match it: create alarms for pending reminders, clear alarms for removed ones, fire anything overdue.
 * This never depends on a message from the page arriving, so a sleeping worker cannot lose a reminder.
 */
let reconciling: Promise<void> | null = null;
function reconcile(): Promise<void> {
  if (reconciling) return reconciling;
  reconciling = (async () => {
    let all = await loadReminders();
    // Fired reminders older than a week are noise; drop them so storage does not grow forever.
    const weekAgo = Date.now() - 7 * 86400e3;
    const pruned = all.filter((r) => !(r.fired && r.when < weekAgo));
    if (pruned.length !== all.length) { all = pruned; await saveReminders(all); }
    const alarms = await browser.alarms.getAll();
    const wanted = new Map(all.filter((r) => !r.fired).map((r) => [ALARM_PREFIX + r.id, r] as const));
    for (const a of alarms) {
      if (a.name.startsWith(ALARM_PREFIX) && !wanted.has(a.name)) await browser.alarms.clear(a.name);
    }
    for (const [name, r] of wanted) {
      if (r.when <= Date.now()) { await notify(r); continue; }
      const existing = alarms.find((a) => a.name === name);
      if (!existing || Math.abs(existing.scheduledTime - r.when) > 1000) await browser.alarms.create(name, { when: r.when });
    }
  })().catch((err) => console.error('[fogar] reminder reconcile failed', err)).finally(() => { reconciling = null; });
  return reconciling;
}

/**
 * "Ask Fogar about …": read the page the user is on (activeTab grants this for the click), stash the context in
 * session storage, and open a new tab that picks it up. If the page cannot be read, the selection alone is used.
 */
async function askAbout(tabId: number | undefined, frameId: number | undefined, selectionText: string): Promise<void> {
  let ctx: PageContext = { title: '', url: '', selection: selectionText.replace(/\s+/g, ' ').trim(), excerpt: '' };
  if (tabId !== undefined) {
    try {
      const target: any = { tabId };
      if (frameId !== undefined) target.frameIds = [frameId];
      const [res] = await browser.scripting.executeScript({ target, func: extractPageContext, args: [selectionText] });
      if (res?.result) ctx = { ...ctx, ...(res.result as PageContext) };
    } catch (err) {
      console.warn('[fogar] could not read the page for context', err);
    }
  }
  const id = Math.random().toString(36).slice(2, 10);
  await browser.storage.session.set({ [CTX_KEY(id)]: ctx });
  await browser.tabs.create({ url: browser.runtime.getURL(`/newtab.html?ctx=${id}` as any) });
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    // removeAll first: on an extension update the old item still exists and create() would throw on the duplicate id.
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({ id: 'fogar-ask', title: 'Ask Fogar about “%s”', contexts: ['selection'] });
    void reconcile();
  });
  browser.runtime.onStartup.addListener(() => void reconcile());
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && REMINDERS_KEY in changes) void reconcile();
  });
  browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type === 'reminders.changed') { void reconcile().then(() => sendResponse({ ok: true })); return true; }
    if (import.meta.env.WXT_E2E === '1' && msg?.type === 'test.contextClick') {
      // Test build only: the context menu cannot be clicked from automation, so the suite drives the same path here.
      void askAbout(msg.tabId, undefined, msg.selectionText).then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    return false;
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'fogar-ask' || !info.selectionText) return;
    void askAbout(tab?.id, info.frameId, info.selectionText);
  });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    const id = alarm.name.slice(ALARM_PREFIX.length);
    const reminder = (await loadReminders()).find((r) => r.id === id);
    if (reminder && !reminder.fired) await notify(reminder);
  });

  browser.notifications.onClicked.addListener((id) => {
    if (id.startsWith(ALARM_PREFIX)) void browser.tabs.create({ url: browser.runtime.getURL('/newtab.html') });
  });
});

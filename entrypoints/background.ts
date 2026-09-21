import { REMINDERS_KEY, loadReminders, saveReminders, type Reminder } from '@/lib/reminders';

const ALARM_PREFIX = 'fogar-reminder:';

async function notify(reminder: Reminder) {
  await browser.notifications.create(ALARM_PREFIX + reminder.id, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title: 'Fogar reminder',
    message: reminder.label,
    priority: 2,
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
    const all = await loadReminders();
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
    return false;
  });

  browser.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== 'fogar-ask' || !info.selectionText) return;
    void browser.tabs.create({ url: browser.runtime.getURL(`/newtab.html?q=${encodeURIComponent(info.selectionText)}`) });
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

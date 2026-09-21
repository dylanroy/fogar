import { loadReminders, saveReminders, type Reminder } from '@/lib/reminders';

const ALARM_PREFIX = 'fogar-reminder:';

async function schedule(reminder: Reminder) {
  await browser.alarms.create(ALARM_PREFIX + reminder.id, { when: Math.max(reminder.when, Date.now() + 1000) });
}

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

/** Alarms survive restarts in Chrome, but re-sync from storage anyway and fire anything missed while the browser was closed. */
async function resync() {
  const all = await loadReminders();
  for (const r of all) {
    if (r.fired) continue;
    if (r.when <= Date.now()) await notify(r);
    else await schedule(r);
  }
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({ id: 'fogar-ask', title: 'Ask Fogar about “%s”', contexts: ['selection'] });
    void resync();
  });
  browser.runtime.onStartup.addListener(() => void resync());

  browser.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== 'fogar-ask' || !info.selectionText) return;
    void browser.tabs.create({ url: browser.runtime.getURL(`/newtab.html?q=${encodeURIComponent(info.selectionText)}`) });
  });

  browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    (async () => {
      if (msg?.type === 'reminder.schedule') await schedule(msg.reminder as Reminder);
      else if (msg?.type === 'reminder.cancel') await browser.alarms.clear(ALARM_PREFIX + msg.id);
      sendResponse({ ok: true });
    })();
    return true;
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

import type { App } from '../app';
import { clear, el, fmtTime } from '@/lib/dom';
import { browser } from 'wxt/browser';
import { addReminder, loadReminders, parseReminder, removeReminder, saveReminders, type Reminder } from '@/lib/reminders';
import { isWeb } from '@/lib/platform';

/** Zero-permission calendar hand-off: a prefilled Google Calendar event link. No OAuth, nothing to verify. */
function gcalLink(r: Reminder): string {
  const fmt = (ts: number) => new Date(ts).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const p = new URLSearchParams({ action: 'TEMPLATE', text: r.label, dates: `${fmt(r.when)}/${fmt(r.when + 30 * 60e3)}`, details: 'Set with Fogar' });
  return `https://calendar.google.com/calendar/render?${p}`;
}

export interface RemindersUI {
  mount(body: HTMLElement): void;
  /** Parse a phrase and open the confirm box. Mounts the widget first if it is not on the page. */
  capture(text: string): void;
  /** Set by the widget host: put the reminders widget back on the page. */
  onNeedMount: (() => Promise<void>) | null;
}

/** The web app's timer for due reminders; one per page however often the widget mounts. */
let webTimer: ReturnType<typeof setInterval> | null = null;

export function createRemindersUI(app: App): RemindersUI {
  let list: HTMLElement | null = null; let input: HTMLInputElement | null = null; let confirmBox: HTMLElement | null = null; let empty: HTMLElement | null = null;

  const render = (all: Reminder[]) => {
    if (!list || !empty) return;
    clear(list);
    const upcoming = all.filter((r) => !r.fired).sort((a, b) => a.when - b.when);
    empty.hidden = upcoming.length > 0;
    for (const r of upcoming) {
      list.append(el('li', { class: 'item' },
        el('span', { class: 'text' }, r.label),
        el('span', { class: 'when' }, fmtTime(r.when)),
        el('a', { class: 'cal', href: gcalLink(r), target: '_blank', rel: 'noopener', title: 'Add to Google Calendar' }, '📅'),
        el('button', { class: 'x', type: 'button', title: 'Remove', onclick: async () => { await removeReminder(r.id); render(await loadReminders()); } }, '×'),
      ));
    }
  };

  const toLocalInput = (ts: number) => {
    const d = new Date(ts); const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  /** Always show what was understood before saving. A wrong reminder is worse than none. */
  const confirmReminder = (label: string, when: number | null) => {
    if (!confirmBox) return;
    const box = confirmBox;
    clear(box); box.hidden = false;
    const labelIn = el('input', { type: 'text', value: label, class: 'line-input' });
    const whenIn = el('input', { type: 'datetime-local', value: when ? toLocalInput(when) : '', class: 'line-input' });
    let saving = false;
    const saveBtn = el('button', { class: 'primary small', type: 'button', onclick: () => void save() }, 'Set reminder');
    const save = async () => {
      if (saving) return;
      const ts = new Date(whenIn.value).getTime();
      if (!labelIn.value.trim() || Number.isNaN(ts)) { app.toast('Pick a time for the reminder.'); return; }
      if (ts < Date.now()) { app.toast('That time has already passed.'); return; }
      saving = true; saveBtn.disabled = true;
      try {
        await addReminder(labelIn.value, ts);
        box.hidden = true; if (input) input.value = '';
        render(await loadReminders());
        app.toast(`Reminder set for ${fmtTime(ts)}`);
      } catch (err) {
        console.error('[fogar] reminder save failed', err);
        app.toast(`Could not save the reminder: ${(err as Error).message}`);
      } finally {
        saving = false; saveBtn.disabled = false;
      }
    };
    whenIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') void save(); });
    box.append(
      el('div', {}, when ? `Remind you about “${label}” ${fmtTime(when)}?` : 'When should this fire?'),
      el('div', { class: 'grid-2' }, el('label', { class: 'field' }, 'Reminder', labelIn), el('label', { class: 'field' }, 'When', whenIn)),
      el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', onclick: () => { box.hidden = true; } }, 'Cancel'), saveBtn),
    );
    if (!when) whenIn.focus();
    box.closest('.widget')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const ui: RemindersUI = {
    onNeedMount: null,
    mount(body) {
      input = el('input', { id: 'reminder-input', class: 'line-input', placeholder: 'Call the dentist tomorrow at 9', autocomplete: 'off' });
      const form = el('form', { id: 'reminder-form' }, input);
      confirmBox = el('div', { id: 'reminder-confirm', class: 'confirm', hidden: true });
      list = el('ul', { id: 'reminder-list', class: 'list' });
      empty = el('p', { id: 'reminder-empty', class: 'muted empty' }, 'Try “in 20 minutes”, “friday at 10”, or “tonight”.');
      const warning = el('p', { id: 'notif-warning', class: 'muted small-note warn', hidden: true });
      const test = el('a', { id: 'notif-test', class: 'link', href: '#' }, 'Send a test notification');
      body.append(form, confirmBox, list, empty, warning,
        el('p', { class: 'muted small-note' }, isWeb() ? 'Reminders fire while Fogar is open on this device; the Chrome extension fires them in the background. ' : 'Reminders fire while Chrome is open. Anything missed shows the next time it starts. ', test));
      form.onsubmit = (e) => { e.preventDefault(); const text = input!.value.trim(); if (text) ui.capture(text); };
      void loadReminders().then(render);

      // The web app has no background worker or alarms API, so the page fires what comes due while it is open.
      if (isWeb() && !webTimer) {
        const tick = async () => {
          const all = await loadReminders(); const now = Date.now();
          const due = all.filter((r) => !r.fired && r.when <= now);
          if (!due.length) return;
          await saveReminders(all.map((r) => (due.some((d) => d.id === r.id) ? { ...r, fired: true } : r)));
          for (const r of due) {
            try { await browser.notifications.create('fogar-reminder:' + r.id, { type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png'), title: 'Fogar reminder', message: r.label, priority: 2 }); }
            catch { app.toast(`Reminder: ${r.label}`); }
          }
          render(await loadReminders());
        };
        webTimer = setInterval(() => void tick(), 30_000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) void tick(); });
        void tick();
      }

      // Chrome can have notifications switched off for the profile or by the OS. Say so where the reminder is set.
      const checkPermission = async () => {
        try {
          const level = await browser.notifications.getPermissionLevel();
          warning.hidden = level !== 'denied';
          if (level === 'denied') warning.textContent = isWeb() ? 'Notifications are blocked for this site, so reminders will only appear in this list. Allow them in the browser’s site settings.' : 'Chrome notifications are turned off for this profile or by the system, so reminders will only appear in this list. Check chrome://settings/content/notifications and your OS notification settings.';
        } catch { /* API unavailable; nothing to warn about */ }
      };
      void checkPermission();
      test.onclick = async (e) => {
        e.preventDefault();
        try {
          await browser.notifications.create('fogar-test-' + Date.now(), {
            type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png'),
            title: 'Fogar reminders are working', message: 'This is what a reminder looks like.', priority: 2,
          });
          app.toast('Test notification sent. If nothing appeared, check the system notification settings for Chrome.');
          void checkPermission();
        } catch (err) {
          app.toast(`Could not show a notification: ${(err as Error).message}`);
        }
      };
    },
    capture(text) {
      const go = () => { const parsed = parseReminder(text); confirmReminder(parsed?.label ?? text, parsed?.when ?? null); };
      if (confirmBox) go();
      else if (ui.onNeedMount) void ui.onNeedMount().then(go);
      else app.toast('Add the Reminders widget first.');
    },
  };
  return ui;
}

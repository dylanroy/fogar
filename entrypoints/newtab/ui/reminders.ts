import type { App } from '../app';
import { $, clear, el, fmtTime } from '@/lib/dom';
import { addReminder, loadReminders, parseReminder, removeReminder, type Reminder } from '@/lib/reminders';

/** Zero-permission calendar hand-off: a prefilled Google Calendar event link. No OAuth, nothing to verify. */
function gcalLink(r: Reminder): string {
  const fmt = (ts: number) => new Date(ts).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const p = new URLSearchParams({ action: 'TEMPLATE', text: r.label, dates: `${fmt(r.when)}/${fmt(r.when + 30 * 60e3)}`, details: 'Set with Fogar' });
  return `https://calendar.google.com/calendar/render?${p}`;
}

export function initReminders(app: App): void {
  const list = $('reminder-list'); const input = $<HTMLInputElement>('reminder-input'); const confirmBox = $('reminder-confirm');

  const render = (all: Reminder[]) => {
    clear(list);
    const upcoming = all.filter((r) => !r.fired).sort((a, b) => a.when - b.when);
    $('reminder-empty').hidden = upcoming.length > 0;
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
    clear(confirmBox); confirmBox.hidden = false;
    const labelIn = el('input', { type: 'text', value: label, class: 'line-input' });
    const whenIn = el('input', { type: 'datetime-local', value: when ? toLocalInput(when) : '', class: 'line-input' });
    let saving = false;
    const save = async () => {
      if (saving) return;
      const ts = new Date(whenIn.value).getTime();
      if (!labelIn.value.trim() || Number.isNaN(ts)) { app.toast('Pick a time for the reminder.'); return; }
      if (ts < Date.now()) { app.toast('That time has already passed.'); return; }
      saving = true; saveBtn.disabled = true;
      try {
        await addReminder(labelIn.value, ts);
        confirmBox.hidden = true; input.value = '';
        render(await loadReminders());
        app.toast(`Reminder set for ${fmtTime(ts)}`);
      } catch (err) {
        console.error('[fogar] reminder save failed', err);
        app.toast(`Could not save the reminder: ${(err as Error).message}`);
      } finally {
        saving = false; saveBtn.disabled = false;
      }
    };
    const saveBtn = el('button', { class: 'primary small', type: 'button', onclick: () => void save() }, 'Set reminder');
    whenIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') void save(); });
    confirmBox.append(
      el('div', {}, when ? `Remind you about “${label}” ${fmtTime(when)}?` : 'When should this fire?'),
      el('div', { class: 'grid-2' }, el('label', { class: 'field' }, 'Reminder', labelIn), el('label', { class: 'field' }, 'When', whenIn)),
      el('div', { class: 'row-actions' },
        el('button', { class: 'ghost small', type: 'button', onclick: () => { confirmBox.hidden = true; } }, 'Cancel'),
        saveBtn),
    );
    if (!when) whenIn.focus();
  };

  $('reminder-form').onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const parsed = parseReminder(text);
    confirmReminder(parsed?.label ?? text, parsed?.when ?? null);
  };
  void loadReminders().then(render);
}

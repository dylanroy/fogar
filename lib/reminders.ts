import { browser } from 'wxt/browser';
import { getItem, setItem, uid } from './store';

export interface Reminder { id: string; label: string; when: number; createdAt: number; fired?: boolean }

export const REMINDERS_KEY = 'fogar.reminders';
export const loadReminders = () => getItem<Reminder[]>(REMINDERS_KEY, []);
export const saveReminders = (r: Reminder[]) => setItem(REMINDERS_KEY, r);

export async function addReminder(label: string, when: number): Promise<Reminder> {
  const reminder: Reminder = { id: uid(), label: label.trim(), when, createdAt: Date.now() };
  const all = await loadReminders();
  all.push(reminder);
  all.sort((a, b) => a.when - b.when);
  await saveReminders(all);
  await browser.runtime.sendMessage({ type: 'reminder.schedule', reminder });
  return reminder;
}

export async function removeReminder(id: string): Promise<void> {
  await saveReminders((await loadReminders()).filter((r) => r.id !== id));
  await browser.runtime.sendMessage({ type: 'reminder.cancel', id });
}

const UNIT_MS: Record<string, number> = { minute: 60e3, min: 60e3, hour: 3600e3, hr: 3600e3, day: 86400e3, week: 7 * 86400e3 };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Deterministic parse of the common ways people say when. Returns null when no time is found,
 * so the UI can ask instead of guessing. Examples: "in 20 minutes", "at 3pm", "tomorrow 9am",
 * "friday at 10", "tonight", "next week".
 */
export function parseReminder(input: string, now = Date.now()): { label: string; when: number } | null {
  let text = ` ${input.trim()} `;
  const base = new Date(now);
  let when: Date | null = null;

  const rel = text.match(/\bin\s+(\d+|a|an)\s+(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i);
  if (rel) {
    const n = /^(a|an)$/i.test(rel[1]!) ? 1 : parseInt(rel[1]!, 10);
    const unit = rel[2]!.toLowerCase().replace(/s$/, '');
    when = new Date(now + n * (UNIT_MS[unit] ?? 60e3));
    text = text.replace(rel[0], ' ');
  } else {
    let dayOffset: number | null = null;
    let hour: number | null = null; let minute = 0;

    const dayWord = text.match(/\b(today|tomorrow|tonight)\b/i);
    if (dayWord) {
      const w = dayWord[1]!.toLowerCase();
      dayOffset = w === 'tomorrow' ? 1 : 0;
      if (w === 'tonight') { hour = 20; }
      text = text.replace(dayWord[0], ' ');
    }
    const weekday = text.match(/\b(?:on\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i);
    if (weekday && dayOffset === null) {
      const target = DAYS.findIndex((d) => d.startsWith(weekday[1]!.toLowerCase().slice(0, 3)));
      let diff = (target - base.getDay() + 7) % 7;
      if (diff === 0 || /next/i.test(weekday[0])) diff = diff === 0 ? 7 : diff;
      dayOffset = diff;
      text = text.replace(weekday[0], ' ');
    }
    const nextWeek = text.match(/\bnext\s+week\b/i);
    if (nextWeek && dayOffset === null) { dayOffset = 7; text = text.replace(nextWeek[0], ' '); }

    const time = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i);
    if (time && (time[2] || time[3] || /\bat\s+\d/i.test(text))) {
      hour = parseInt(time[1]!, 10); minute = time[2] ? parseInt(time[2], 10) : 0;
      const ap = time[3]?.toLowerCase().replace(/\./g, '');
      if (ap === 'pm' && hour < 12) hour += 12;
      if (ap === 'am' && hour === 12) hour = 0;
      if (!ap && hour <= 7 && dayOffset === null) hour += 12; // "at 5" almost always means 5 pm
      text = text.replace(time[0], ' ');
    } else if (text.match(/\b(noon|midday)\b/i)) { hour = 12; text = text.replace(/\b(noon|midday)\b/i, ' '); }
    else if (text.match(/\bmidnight\b/i)) { hour = 0; dayOffset = (dayOffset ?? 0) + 1; text = text.replace(/\bmidnight\b/i, ' '); }
    else if (text.match(/\b(this\s+)?(morning|afternoon|evening)\b/i)) {
      const m = text.match(/\b(this\s+)?(morning|afternoon|evening)\b/i)!;
      hour = m[2]!.toLowerCase() === 'morning' ? 9 : m[2]!.toLowerCase() === 'afternoon' ? 14 : 18;
      text = text.replace(m[0], ' ');
    }

    if (dayOffset === null && hour === null) return null;
    when = new Date(base);
    when.setSeconds(0, 0);
    when.setDate(base.getDate() + (dayOffset ?? 0));
    when.setHours(hour ?? 9, minute, 0, 0);
    if (dayOffset === null && when.getTime() <= now) when.setDate(when.getDate() + 1); // time already passed today
  }

  const label = text
    .replace(/\b(please\s+)?remind\s+me\s*(to|about|that)?\b/i, ' ')
    .replace(/\b(at|on|by)\s*$/i, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\W+|\W+$/g, '')
    .trim();
  if (!when || Number.isNaN(when.getTime())) return null;
  return { label: label || 'Reminder', when: when.getTime() };
}

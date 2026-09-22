/**
 * Enough of RFC 5545 to show an agenda: VEVENT with DTSTART/DTEND or DURATION, all-day dates, TZID and UTC
 * times, RRULE (DAILY, WEEKLY with BYDAY, MONTHLY, YEARLY, INTERVAL, COUNT, UNTIL), EXDATE, RECURRENCE-ID
 * overrides, and CANCELLED status. Anything fancier is skipped rather than shown wrong.
 */
export interface AgendaEvent {
  uid: string; summary: string; location?: string; description?: string; start: number; end: number; allDay: boolean;
  /** The event's own page, when the feed publishes one. */
  url?: string;
  /** A video call to join, from X-GOOGLE-CONFERENCE, LOCATION or the description. */
  meetUrl?: string;
  organizer?: string;
  attendees: string[];
  /** This occurrence came out of an RRULE, so a deep link needs to name the instance. */
  recurring: boolean;
}

interface Wall { y: number; m: number; d: number; h: number; mi: number; s: number; tz: string | null; date: boolean }
interface RawEvent {
  uid: string; summary: string; location?: string; description?: string; url?: string; conference?: string;
  organizer?: string; attendees: string[]; start: Wall; end: Wall | null; durationMs: number | null;
  rrule: Record<string, string> | null; exdates: Set<string>; recurrenceId: Wall | null; cancelled: boolean;
}

const WINDOWS_TZ: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles', 'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest', 'India Standard Time': 'Asia/Kolkata',
  'Tokyo Standard Time': 'Asia/Tokyo', 'AUS Eastern Standard Time': 'Australia/Sydney', 'UTC': 'UTC',
};

function unfold(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function unescapeText(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\;/g, ';').replace(/\\\\/g, '\\');
}

/** Hosts whose links are a meeting you can join. An allowlist, so a stray link in a description is never mistaken for one. */
const MEET_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)meet\.google\.com$/, 'Google Meet'],
  [/(^|\.)zoom\.(us|com)$/, 'Zoom'],
  [/(^|\.)zoomgov\.com$/, 'Zoom'],
  [/(^|\.)teams\.microsoft\.com$/, 'Teams'],
  [/(^|\.)teams\.live\.com$/, 'Teams'],
  [/(^|\.)webex\.com$/, 'Webex'],
  [/(^|\.)whereby\.com$/, 'Whereby'],
  [/(^|\.)chime\.aws$/, 'Chime'],
  [/(^|\.)meet\.jit\.si$/, 'Jitsi'],
  [/(^|\.)bluejeans\.com$/, 'BlueJeans'],
  [/(^|\.)(goto\.com|gotomeeting\.com)$/, 'GoTo'],
];

/** The provider behind a join link, for labelling the button. */
export function meetingLabel(url: string): string {
  try {
    const host = new URL(url).host.toLowerCase();
    for (const [re, name] of MEET_HOSTS) if (re.test(host)) return name;
  } catch { /* fall through */ }
  return 'call';
}

/** The first joinable video call in any of the given fields, in the order given. */
export function findMeetingLink(...fields: Array<string | undefined>): string | undefined {
  for (const field of fields) {
    if (!field) continue;
    for (const raw of field.match(/https?:\/\/[^\s<>"']+/g) ?? []) {
      const url = raw.replace(/[.,;:)\]]+$/, '');
      try {
        const host = new URL(url).host.toLowerCase();
        if (MEET_HOSTS.some(([re]) => re.test(host))) return url;
      } catch { /* not a URL we can use */ }
    }
  }
  return undefined;
}

/** Feeds put HTML and Google's boilerplate divider in DESCRIPTION. Reduce it to something readable. */
export function cleanDescription(text: string): string {
  return text
    .split(/-::~:~:[^\n]*/)[0]!
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The display name of an ORGANIZER/ATTENDEE line: its CN, else the mailto address. */
function personName(value: string, params: Record<string, string>): string {
  const cn = params.CN?.replace(/^"|"$/g, '');
  if (cn) return unescapeText(cn);
  return value.replace(/^mailto:/i, '').trim();
}

function parseWall(value: string, params: Record<string, string>): Wall | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const date = params.VALUE === 'DATE' || !m[4];
  let tz: string | null = null;
  if (m[7]) tz = 'UTC';
  else if (params.TZID) { const id = params.TZID.replace(/^"|"$/g, ''); tz = WINDOWS_TZ[id] ?? id; }
  return { y: +m[1]!, m: +m[2]!, d: +m[3]!, h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0), tz, date };
}

/** Offset of a zone at an instant, in ms, via Intl. Falls back to the local zone for unknown ids. */
function tzOffset(instant: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(instant));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - Math.floor(instant / 1000) * 1000;
  } catch {
    return -new Date(instant).getTimezoneOffset() * 60e3;
  }
}

function wallToInstant(w: Wall): number {
  if (w.date || !w.tz) return new Date(w.y, w.m - 1, w.d, w.h, w.mi, w.s).getTime(); // floating or all-day: local
  if (w.tz === 'UTC') return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  let utc = guess - tzOffset(guess, w.tz);
  utc = guess - tzOffset(utc, w.tz);
  return utc;
}

function parseDuration(v: string): number | null {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

export function parseIcs(text: string): RawEvent[] {
  const events: RawEvent[] = [];
  let cur: Partial<RawEvent> & { exdates: Set<string>; attendees: string[] } | null = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: new Set(), attendees: [], rrule: null, end: null, durationMs: null, recurrenceId: null, cancelled: false }; continue; }
    if (line === 'END:VEVENT') { if (cur && cur.start && cur.uid) events.push({ summary: '(untitled)', ...cur } as RawEvent); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':'); if (idx < 0) continue;
    const head = line.slice(0, idx); const value = line.slice(idx + 1);
    const [name, ...paramParts] = head.split(';');
    const params: Record<string, string> = {};
    for (const p of paramParts) { const eq = p.indexOf('='); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1); }
    switch (name!.toUpperCase()) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.summary = unescapeText(value); break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'DESCRIPTION': cur.description = unescapeText(value); break;
      case 'URL': if (/^https?:/i.test(value)) cur.url = value; break;
      case 'X-GOOGLE-CONFERENCE': cur.conference = value; break;
      case 'ORGANIZER': cur.organizer = personName(value, params); break;
      case 'ATTENDEE': { const who = personName(value, params); if (who) cur.attendees.push(who); break; }
      case 'DTSTART': cur.start = parseWall(value, params) ?? undefined; break;
      case 'DTEND': cur.end = parseWall(value, params); break;
      case 'DURATION': cur.durationMs = parseDuration(value); break;
      case 'RRULE': cur.rrule = Object.fromEntries(value.split(';').map((kv) => { const [k, v] = kv.split('='); return [k!.toUpperCase(), v ?? '']; })); break;
      case 'EXDATE': for (const v of value.split(',')) { const w = parseWall(v, params); if (w) cur.exdates.add(String(wallToInstant(w))); } break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseWall(value, params); break;
      case 'STATUS': cur.cancelled = value.toUpperCase() === 'CANCELLED'; break;
    }
  }
  return events;
}

const DAY = 86400e3;
const BYDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function addWall(w: Wall, days: number, months = 0, years = 0): Wall {
  const d = new Date(w.y + years, w.m - 1 + months, w.d + days, w.h, w.mi, w.s);
  return { ...w, y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

/** Occurrences of every event that overlap [windowStart, windowEnd). */
export function expandEvents(raw: RawEvent[], windowStart: number, windowEnd: number): AgendaEvent[] {
  const out: AgendaEvent[] = [];
  const overrides = new Set<string>();
  for (const e of raw) if (e.recurrenceId) overrides.add(`${e.uid}@${wallToInstant(e.recurrenceId)}`);

  const emit = (e: RawEvent, startWall: Wall) => {
    const start = wallToInstant(startWall);
    let end: number;
    if (e.durationMs !== null) end = start + e.durationMs;
    else if (e.end) { const base = wallToInstant(e.start); end = start + (wallToInstant(e.end) - base); }
    else end = start + (startWall.date ? DAY : 0);
    if (end <= start) end = start + (startWall.date ? DAY : 30 * 60e3);
    if (end <= windowStart || start >= windowEnd) return;
    out.push({
      uid: e.uid, summary: e.summary, location: e.location,
      description: e.description ? cleanDescription(e.description) || undefined : undefined,
      start, end, allDay: startWall.date, url: e.url,
      meetUrl: findMeetingLink(e.conference, e.location, e.description),
      organizer: e.organizer, attendees: e.attendees, recurring: e.rrule !== null,
    });
  };

  for (const e of raw) {
    if (e.cancelled) continue;
    if (!e.rrule) { emit(e, e.start); continue; }
    const r = e.rrule;
    const freq = r.FREQ; const interval = Math.max(1, parseInt(r.INTERVAL ?? '1', 10) || 1);
    const until = r.UNTIL ? wallToInstant(parseWall(r.UNTIL, {}) ?? e.start) : Infinity;
    let remaining = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
    const byday = r.BYDAY ? r.BYDAY.split(',').map((s) => BYDAY[s.replace(/^[-+]?\d+/, '')]).filter((n) => n !== undefined) as number[] : null;
    let cursor: Wall = e.start; let guard = 0;
    const consider = (w: Wall) => {
      const inst = wallToInstant(w);
      if (inst > until || remaining <= 0) return false;
      remaining--;
      if (!e.exdates.has(String(inst)) && !overrides.has(`${e.uid}@${inst}`)) emit(e, w);
      return true;
    };
    while (guard++ < 3000 && remaining > 0) {
      const cursorInst = wallToInstant(cursor);
      if (cursorInst >= windowEnd || cursorInst > until) break;
      if (freq === 'WEEKLY' && byday && byday.length) {
        // every BYDAY weekday within this cursor's week (weeks start on the cursor's own weekday)
        const weekStart = addWall(cursor, -new Date(cursorInst).getDay());
        for (const wd of [...byday].sort()) {
          const w = addWall(weekStart, wd);
          const inst = wallToInstant(w);
          if (inst < wallToInstant(e.start)) continue;
          if (!consider(w)) break;
        }
        cursor = addWall(cursor, 7 * interval);
      } else if (freq === 'DAILY') { if (!consider(cursor)) break; cursor = addWall(cursor, interval); }
      else if (freq === 'WEEKLY') { if (!consider(cursor)) break; cursor = addWall(cursor, 7 * interval); }
      else if (freq === 'MONTHLY') { if (!consider(cursor)) break; cursor = addWall(cursor, 0, interval); }
      else if (freq === 'YEARLY') { if (!consider(cursor)) break; cursor = addWall(cursor, 0, 0, interval); }
      else { emit(e, e.start); break; } // unsupported FREQ: show the first occurrence only
    }
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A deep link to the event in Google Calendar, derived from the feed's calendar id and the event's uid.
 * Google's ICS feeds carry no URL property, so this is the only way in; it applies to Google feeds only.
 */
export function googleEventUrl(feedUrl: string, ev: AgendaEvent): string | undefined {
  const m = feedUrl.match(/calendar\.google\.com\/calendar\/ical\/([^/]+)\//);
  if (!m) return undefined;
  const calendarId = decodeURIComponent(m[1]!);
  let id = ev.uid.replace(/@google\.com$/i, '');
  if (ev.recurring && !/_R\d/.test(id)) {
    const d = new Date(ev.start);
    id += ev.allDay
      ? `_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
      : `_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }
  const eid = btoa(`${id} ${calendarId}`).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `https://calendar.google.com/calendar/event?action=VIEW&eid=${eid}`;
}

/** "45 min", "1 hr", "1 hr 30 min" — how long an event runs. */
export function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60e3);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60); const m = mins % 60;
  const hours = `${h} hr`;
  return m ? `${hours} ${m} min` : hours;
}

export function agendaWindow(now = Date.now()): { start: number; end: number } {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  return { start: d.getTime(), end: d.getTime() + 2 * DAY };
}

import { browser } from 'wxt/browser';
import { getItem, setItem } from './store';

/**
 * Two ways to read a Gmail inbox from this browser, neither through a Fogar server.
 *
 * 1. The Atom feed. Gmail publishes the unread messages of the inbox, or of one label, at
 *    mail.google.com/mail/feed/atom. Fogar fetches it with the cookies of the Gmail account you are signed
 *    into, so there is nothing to set up beyond allowing that one origin. A Gmail filter that applies a label
 *    is the "filter" here: point the widget at the label. Only unread mail appears; that is what the feed is.
 *
 * 2. The Gmail API with your own OAuth client. Any Gmail search ("from:stripe is:unread newer_than:7d") and
 *    read as well as unread mail. Google's readonly Gmail scope is "restricted", which for a published app means
 *    a yearly security assessment, so Fogar does not ship a client id. You create one in your own Google Cloud
 *    project (five minutes, free, test mode) and paste it here: your key, your account, your data.
 */
export type EmailProvider = 'gmail-feed' | 'gmail-api';

export interface EmailConfig {
  name?: string;
  provider: EmailProvider;
  /** How many messages to show, 1 to 25. */
  count: number;
  /** Feed: a label name (blank for the inbox). API: a Gmail search query (blank for the inbox). */
  filter: string;
  /** Only messages whose sender or subject contains this, applied after fetching. */
  match: string;
  /** Which signed-in Google account, as in mail.google.com/mail/u/N/. */
  account: number;
  clientId?: string;
  /** Test hook: base URL that replaces Google's hosts. Not exposed in the UI. */
  endpoint?: string;
}

export interface EmailMessage {
  id: string;
  threadId?: string;
  from: string;
  fromEmail?: string;
  subject: string;
  snippet: string;
  date: number;
  unread: boolean;
  url: string;
}

export const DEFAULT_EMAIL_CONFIG = (): EmailConfig => ({ provider: 'gmail-feed', count: 8, filter: '', match: '', account: 0 });

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_KEY = (clientId: string) => `fogar.email.auth.${clientId}`;

const gmailBase = (cfg: EmailConfig) => cfg.endpoint ? `${cfg.endpoint}/gmail` : `https://mail.google.com/mail`;
const apiBase = (cfg: EmailConfig) => cfg.endpoint ? `${cfg.endpoint}/gmail/v1` : 'https://gmail.googleapis.com/gmail/v1';

/** The web address of the account's mailbox, for "Open Gmail" and for message links. */
export const gmailWebUrl = (account: number) => `https://mail.google.com/mail/u/${account || 0}/`;
export const threadUrl = (threadId: string, account: number) => `${gmailWebUrl(account)}#all/${threadId}`;
export const searchUrl = (q: string, account: number) => `${gmailWebUrl(account)}#search/${encodeURIComponent(q)}`;

// ---------- Atom feed ----------

export function gmailFeedUrl(cfg: EmailConfig): string {
  const label = cfg.filter.trim();
  return `${gmailBase(cfg)}/u/${cfg.account || 0}/feed/atom${label ? `/${encodeURIComponent(label)}` : ''}`;
}

/** Gmail's feed: <fullcount> unread, then one <entry> per unread message with title, summary, link, author, and issued. */
export function parseGmailAtom(xml: string, account: number): { total: number; messages: EmailMessage[] } {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'feed') throw new Error('Google did not return the mail feed. Open Gmail in this browser and sign in, then refresh.');
  const t = (p: Element | null | undefined, name: string) => Array.from(p?.children ?? []).find((c) => c.localName === name)?.textContent?.trim() ?? '';
  const total = Number(t(doc.documentElement, 'fullcount')) || 0;
  const messages: EmailMessage[] = Array.from(doc.documentElement.children).filter((c) => c.localName === 'entry').map((en) => {
    const link = Array.from(en.children).find((c) => c.localName === 'link')?.getAttribute('href') ?? '';
    const author = Array.from(en.children).find((c) => c.localName === 'author');
    let id = t(en, 'id');
    const m = link.match(/message_id=([0-9a-f]+)/i); if (m) id = m[1]!;
    const url = m ? threadUrl(m[1]!, account) : link || gmailWebUrl(account);
    return {
      id, from: t(author, 'name') || t(author, 'email') || 'Unknown sender', fromEmail: t(author, 'email') || undefined,
      subject: t(en, 'title') || '(no subject)', snippet: t(en, 'summary'), date: Date.parse(t(en, 'issued') || t(en, 'modified')) || 0, unread: true, url,
    };
  });
  return { total, messages };
}

export async function fetchGmailFeed(cfg: EmailConfig, signal?: AbortSignal): Promise<{ total: number; messages: EmailMessage[] }> {
  const res = await fetch(gmailFeedUrl(cfg), { signal, credentials: 'include', cache: 'no-store', redirect: 'follow' });
  if (res.status === 401 || res.status === 403) throw new Error('Gmail wants you signed in. Open mail.google.com in this browser, then refresh.');
  if (!res.ok) throw new Error(`Gmail returned ${res.status}${cfg.filter ? `. Check the label name “${cfg.filter}”` : ''}.`);
  const body = await res.text();
  // A signed-out browser gets the login page with a 200.
  if (/^\s*<!doctype html|<html/i.test(body)) throw new Error('Gmail wants you signed in. Open mail.google.com in this browser, then refresh.');
  return parseGmailAtom(body, cfg.account);
}

// ---------- OAuth with the user's own client id ----------

export interface GmailAuth { accessToken: string; expiresAt: number; clientId: string }

/** Chrome hands each extension a redirect address for OAuth; it goes in the user's OAuth client as an authorised redirect URI. */
export function redirectUrl(): string {
  try { return browser.identity.getRedirectURL(); } catch { return `https://${browser.runtime.id}.chromiumapp.org/`; }
}

export async function hasIdentityPermission(): Promise<boolean> {
  try { return await browser.permissions.contains({ permissions: ['identity'] }); } catch { return false; }
}
export async function requestIdentityPermission(): Promise<boolean> {
  try { return await browser.permissions.request({ permissions: ['identity'] }); } catch { return false; }
}

/** Run Google's implicit flow. `interactive: false` renews a token in the background while the Google session lasts. */
export async function connectGmail(clientId: string, interactive: boolean): Promise<GmailAuth> {
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUrl(), response_type: 'token', scope: GMAIL_SCOPE,
    include_granted_scopes: 'true', prompt: interactive ? 'select_account consent' : 'none',
  });
  const result = await browser.identity.launchWebAuthFlow({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, interactive });
  if (!result) throw new Error('Google did not return to Fogar.');
  const frag = new URLSearchParams(new URL(result).hash.replace(/^#/, ''));
  const err = frag.get('error');
  if (err) throw new Error(err === 'access_denied' ? 'You did not allow Fogar to read your mail.' : `Google said: ${err}`);
  const accessToken = frag.get('access_token');
  if (!accessToken) throw new Error('Google returned no access token.');
  const auth: GmailAuth = { accessToken, expiresAt: Date.now() + (Number(frag.get('expires_in')) || 3600) * 1000 - 60_000, clientId };
  await setItem(AUTH_KEY(clientId), auth);
  return auth;
}

export const loadGmailAuth = (clientId: string) => getItem<GmailAuth | null>(AUTH_KEY(clientId), null);
export const disconnectGmail = (clientId: string) => setItem(AUTH_KEY(clientId), null);

/** A valid token, renewed silently when it has expired. Throws when the user has to click Connect again. */
export async function gmailToken(clientId: string): Promise<string> {
  const saved = await loadGmailAuth(clientId);
  if (saved && saved.expiresAt > Date.now()) return saved.accessToken;
  if (!saved) throw new Error('Connect Gmail first.');
  try { return (await connectGmail(clientId, false)).accessToken; } catch { throw new Error('Your Gmail connection expired. Connect again.'); }
}

interface GmailHeader { name: string; value: string }
interface GmailMessageMeta { id: string; threadId: string; snippet?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: GmailHeader[] } }

/** Split "Jane Doe <jane@example.com>" into a name and an address. */
export function parseFrom(raw: string): { name: string; email?: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1]!.trim() || m[2]!.trim(), email: m[2]!.trim() };
  return { name: raw.trim() || 'Unknown sender', email: /@/.test(raw) ? raw.trim() : undefined };
}

/** Gmail's snippets are HTML-escaped; the widget renders text. */
const unescapeHtml = (s: string) => { const el = document.createElement('textarea'); el.innerHTML = s; return el.value; };

export async function fetchGmailApi(cfg: EmailConfig, token: string, signal?: AbortSignal): Promise<{ total: number; messages: EmailMessage[] }> {
  const q = cfg.filter.trim() || 'in:inbox';
  const headers = { Authorization: `Bearer ${token}` };
  const listRes = await fetch(`${apiBase(cfg)}/users/me/messages?${new URLSearchParams({ q, maxResults: String(Math.min(50, Math.max(1, cfg.count * 2))) })}`, { headers, signal, cache: 'no-store' });
  if (listRes.status === 401) throw new Error('Gmail rejected the token. Connect again.');
  if (!listRes.ok) throw new Error(`Gmail API returned ${listRes.status}.`);
  const list = await listRes.json() as { messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number };
  const ids = (list.messages ?? []).slice(0, Math.min(25, cfg.count * 2));
  const metas = await Promise.all(ids.map(async ({ id }) => {
    const r = await fetch(`${apiBase(cfg)}/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers, signal });
    if (!r.ok) return null;
    return await r.json() as GmailMessageMeta;
  }));
  const messages: EmailMessage[] = [];
  for (const m of metas) {
    if (!m) continue;
    const h = (name: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? '';
    const from = parseFrom(h('From'));
    messages.push({
      id: m.id, threadId: m.threadId, from: from.name, fromEmail: from.email, subject: h('Subject') || '(no subject)',
      snippet: unescapeHtml(m.snippet ?? ''), date: Number(m.internalDate) || Date.parse(h('Date')) || 0,
      unread: (m.labelIds ?? []).includes('UNREAD'), url: threadUrl(m.threadId, cfg.account),
    });
  }
  messages.sort((a, b) => b.date - a.date);
  return { total: list.resultSizeEstimate ?? messages.length, messages };
}

/** Both providers, one shape. `match` narrows to sender or subject text afterwards; `count` cuts the list. */
export async function fetchEmail(cfg: EmailConfig, signal?: AbortSignal): Promise<{ total: number; messages: EmailMessage[] }> {
  const got = cfg.provider === 'gmail-api'
    ? await fetchGmailApi(cfg, await gmailToken(cfg.clientId ?? ''), signal)
    : await fetchGmailFeed(cfg, signal);
  const needle = cfg.match.trim().toLowerCase();
  const kept = needle ? got.messages.filter((m) => `${m.from} ${m.fromEmail ?? ''} ${m.subject}`.toLowerCase().includes(needle)) : got.messages;
  return { total: got.total, messages: kept.slice(0, Math.max(1, Math.min(25, cfg.count || 8))) };
}

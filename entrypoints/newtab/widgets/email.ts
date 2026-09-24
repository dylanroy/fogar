import type { WidgetInstance } from '@/lib/layout';
import { clear, el } from '@/lib/dom';
import { getItem, setItem } from '@/lib/store';
import { ensureOriginPermission } from '@/lib/settings';
import {
  DEFAULT_EMAIL_CONFIG, connectGmail, disconnectGmail, fetchEmail, gmailWebUrl, hasIdentityPermission, loadGmailAuth, redirectUrl, requestIdentityPermission, searchUrl,
  type EmailConfig, type EmailMessage,
} from '@/lib/email';
import { ago, cacheKey, field, relTime, setupForm, type WidgetCtx, type WidgetDef } from './shared';

/**
 * Inbox: the latest mail, from Gmail, on the new tab. Two connections: the unread feed Gmail already publishes
 * for the signed-in account (nothing to set up; a label is the filter), or the Gmail API through an OAuth
 * client the user creates in their own Google project (any search query, read and unread).
 */
const TTL = 5 * 60e3;
interface MailCache { fetchedAt: number; total: number; messages: EmailMessage[] }

const cfgOf = (inst: WidgetInstance): EmailConfig => ({ ...DEFAULT_EMAIL_CONFIG(), ...(inst.config as Partial<EmailConfig>) });

function setup(body: HTMLElement, inst: WidgetInstance, ctx: WidgetCtx, cancellable: boolean) {
  clear(body);
  const cfg = cfgOf(inst);
  const draft: EmailConfig = { ...cfg };
  const radio = (value: EmailConfig['provider'], title: string, note: string) => {
    const input = el('input', { type: 'radio', name: `prov-${inst.id}`, value, checked: draft.provider === value });
    input.onchange = () => { draft.provider = value; paintProvider(); };
    return el('label', { class: 'choice-line' }, input, el('span', {}, el('strong', {}, title), el('span', { class: 'muted' }, ` ${note}`)));
  };
  const name = el('input', { class: 'line-input', type: 'text', value: cfg.name ?? 'Inbox' });
  const account = el('input', { class: 'line-input', type: 'number', min: '0', max: '9', value: String(cfg.account) });
  const count = el('input', { class: 'line-input', type: 'number', min: '1', max: '25', value: String(cfg.count) });
  const match = el('input', { class: 'line-input', type: 'text', value: cfg.match, placeholder: 'e.g. invoice, or a sender', autocomplete: 'off' });
  const label = el('input', { class: 'line-input', type: 'text', value: cfg.provider === 'gmail-feed' ? cfg.filter : '', placeholder: 'Leave blank for the inbox', autocomplete: 'off' });
  const query = el('input', { class: 'line-input', type: 'text', value: cfg.provider === 'gmail-api' ? cfg.filter : '', placeholder: 'e.g. is:unread newer_than:3d, or from:stripe.com', autocomplete: 'off' });
  const clientId = el('input', { class: 'line-input', type: 'text', value: cfg.clientId ?? '', placeholder: '1234-abc.apps.googleusercontent.com', autocomplete: 'off' });
  const redirect = el('input', { class: 'line-input mono', type: 'text', value: redirectUrl(), readOnly: true });
  const connectNote = el('span', { class: 'muted' });
  const connectBtn = el('button', { class: 'ghost small', type: 'button' }, 'Connect Gmail');
  const paintConnect = async () => {
    const id = clientId.value.trim();
    const auth = id ? await loadGmailAuth(id) : null;
    connectBtn.textContent = auth ? 'Reconnect' : 'Connect Gmail';
    connectNote.textContent = auth ? (auth.expiresAt > Date.now() ? 'Connected.' : 'Connected earlier; the token will renew when the widget loads.') : id ? 'Not connected yet.' : 'Paste a client id first.';
  };
  connectBtn.onclick = async () => {
    const id = clientId.value.trim(); if (!id) { ctx.app.toast('Paste your OAuth client id first.'); return; }
    if (!(await hasIdentityPermission()) && !(await requestIdentityPermission())) { ctx.app.toast('Without the identity permission Fogar cannot open Google’s sign-in window.'); return; }
    connectBtn.disabled = true; connectNote.textContent = 'Waiting for Google…';
    try { await connectGmail(id, true); await paintConnect(); ctx.app.toast('Gmail connected.'); }
    catch (err) { connectNote.textContent = (err as Error).message; }
    finally { connectBtn.disabled = false; }
  };
  const disconnect = el('a', { class: 'link', href: '#', onclick: async (e: MouseEvent) => { e.preventDefault(); const id = clientId.value.trim(); if (id) await disconnectGmail(id); await paintConnect(); } }, 'Disconnect');
  const feedBox = el('div', { class: 'setup' },
    el('p', { class: 'muted' }, 'Gmail publishes your unread mail as a feed for the account you are signed into in this browser. Nothing to set up. To show a slice of it, make a Gmail filter that applies a label and name the label here.'),
    field('Label (optional)', label, 'The feed only lists unread messages; that is how Gmail publishes it.'));
  const apiBox = el('div', { class: 'setup' },
    el('p', { class: 'muted' }, 'Any Gmail search, read or unread, through your own OAuth client: in console.cloud.google.com create a project, enable the Gmail API, add an OAuth client of type “Web application” with the redirect address below, put your address under test users, and paste the client id here. Google shows an “unverified app” screen once; that is your own project, not Fogar’s.'),
    field('OAuth client id', clientId),
    field('Authorised redirect URI (copy this into the client)', redirect),
    el('div', { class: 'row-actions' }, connectBtn, connectNote, disconnect),
    field('Search (optional)', query, 'Gmail search syntax. Blank shows the inbox.'));
  const paintProvider = () => { feedBox.hidden = draft.provider !== 'gmail-feed'; apiBox.hidden = draft.provider !== 'gmail-api'; if (draft.provider === 'gmail-api') void paintConnect(); };
  clientId.addEventListener('input', () => void paintConnect());
  paintProvider();
  body.append(
    el('div', { class: 'choices-list' },
      radio('gmail-feed', 'Gmail, unread feed', 'No setup. Unread mail, optionally one label.'),
      radio('gmail-api', 'Gmail API, your own client', 'Any search, read and unread. Five minutes of setup in Google Cloud.')),
    feedBox, apiBox,
    el('div', { class: 'grid-2' }, field('Title', name), field('Google account number', account, '0 is the first account you signed into; mail.google.com/mail/u/1 is 1.'), field('Show up to', count), field('Only if sender or subject contains', match)),
    setupForm([], async () => {
      const provider = draft.provider;
      const next: EmailConfig = {
        ...cfg, name: name.value.trim() || 'Inbox', provider, account: Math.max(0, Math.min(9, Number(account.value) || 0)), count: Math.max(1, Math.min(25, Number(count.value) || 8)),
        match: match.value.trim(), filter: provider === 'gmail-feed' ? label.value.trim() : query.value.trim(), clientId: clientId.value.trim() || undefined,
      };
      if (provider === 'gmail-api' && !next.clientId) { ctx.app.toast('The Gmail API needs your OAuth client id.'); return; }
      if (!next.endpoint) await ensureOriginPermission(provider === 'gmail-api' ? 'https://gmail.googleapis.com/' : 'https://mail.google.com/');
      inst.config = { ...next }; await setItem(cacheKey(inst), null); await ctx.save(inst); ctx.remount(inst);
    }, cancellable ? () => ctx.remount(inst) : undefined, 'Show my mail'),
  );
}

export const email: WidgetDef = {
  type: 'email', title: 'Inbox', description: 'Your latest Gmail, with a label or a search as the filter.', single: false,
  defaultConfig: () => ({ ...DEFAULT_EMAIL_CONFIG(), name: 'Inbox' }),
  name: (inst) => inst.config.name || 'Inbox',
  async render(body, actions, inst, ctx) {
    const cfg = cfgOf(inst);
    if (!inst.config.provider || (cfg.provider === 'gmail-api' && !cfg.clientId)) { setup(body, inst, ctx, !!inst.config.provider); return; }
    const list = el('div', { class: 'mail' });
    const status = el('p', { class: 'muted small-note' }, 'Loading…');
    body.append(list, status);
    const refresh = el('a', { class: 'link', href: '#', onclick: (e: MouseEvent) => { e.preventDefault(); void load(true); } }, 'Refresh');
    const change = el('a', { class: 'link', href: '#', onclick: (e: MouseEvent) => { e.preventDefault(); setup(body, inst, ctx, true); } }, 'Change');
    const openGmail = el('a', { class: 'link', href: cfg.provider === 'gmail-api' && cfg.filter ? searchUrl(cfg.filter, cfg.account) : gmailWebUrl(cfg.account), target: '_blank', rel: 'noopener' }, 'Open Gmail');
    actions.append(el('a', { class: 'ghost small mail-open', href: openGmail.href, target: '_blank', rel: 'noopener' }, 'Open Gmail'));
    const paint = (cache: MailCache) => {
      clear(list);
      if (!cache.messages.length) list.append(el('p', { class: 'muted empty' }, cfg.provider === 'gmail-feed' ? `Nothing unread${cfg.filter ? ` under “${cfg.filter}”` : ''}. Enjoy it.` : 'No mail matches.'));
      for (const m of cache.messages) {
        list.append(el('a', { class: `mail-row${m.unread ? ' unread' : ''}`, href: m.url, target: '_blank', rel: 'noopener', title: m.fromEmail ? `${m.from} <${m.fromEmail}>` : m.from },
          el('span', { class: 'from' }, m.from),
          el('span', { class: 'when' }, relTime(m.date)),
          el('span', { class: 'subj' }, m.subject),
          m.snippet ? el('span', { class: 'snip' }, m.snippet) : null));
      }
      clear(status);
      const unread = cache.messages.filter((m) => m.unread).length;
      const head = cfg.provider === 'gmail-feed' ? `${cache.total} unread${cfg.filter ? ` in “${cfg.filter}”` : ''}` : `${cache.messages.length} shown${unread ? `, ${unread} unread` : ''}`;
      status.append(`${head} · updated ${ago(cache.fetchedAt)} · `, refresh, ' · ', openGmail, ' · ', change);
    };
    const load = async (force: boolean) => {
      try {
        let cache = await getItem<MailCache | null>(cacheKey(inst), null);
        if (force || !cache || !Array.isArray(cache.messages) || Date.now() - cache.fetchedAt > TTL) {
          status.textContent = 'Fetching…';
          const got = await fetchEmail(cfg);
          cache = { fetchedAt: Date.now(), total: got.total, messages: got.messages };
          await setItem(cacheKey(inst), cache);
        }
        paint(cache);
      } catch (err) {
        clear(list); clear(status);
        status.append(`${(err as Error).message} `, refresh, ' · ', openGmail, ' · ', change);
      }
    };
    void load(false);
  },
  configure(body, inst, ctx) { setup(body, inst, ctx, true); },
};

import type { WidgetInstance } from '@/lib/layout';
import { clear, el } from '@/lib/dom';
import { getItem, setItem } from '@/lib/store';
import { ensureOriginPermission } from '@/lib/settings';
import { DEFAULT_JIRA_CONFIG, DEFAULT_JQL, fetchIssues, filterUrl, isCloud, type JiraConfig, type JiraIssue } from '@/lib/jira';
import { ago, cacheKey, field, relTime, setupForm, type WidgetCtx, type WidgetDef } from './shared';

/** Jira: the issues one JQL query returns, read with your own token, on every new tab. */
const TTL = 5 * 60e3;
interface JiraCache { fetchedAt: number; issues: JiraIssue[]; total?: number }

const cfgOf = (inst: WidgetInstance): JiraConfig => ({ ...DEFAULT_JIRA_CONFIG(), ...(inst.config as Partial<JiraConfig>) });

function setup(body: HTMLElement, inst: WidgetInstance, ctx: WidgetCtx, cancellable: boolean) {
  clear(body);
  const cfg = cfgOf(inst);
  const name = el('input', { class: 'line-input', type: 'text', value: cfg.name });
  const site = el('input', { class: 'line-input', type: 'url', value: cfg.site, placeholder: 'https://your-team.atlassian.net', autocomplete: 'off' });
  const email = el('input', { class: 'line-input', type: 'email', value: cfg.email, placeholder: 'you@company.com', autocomplete: 'off' });
  const token = el('input', { class: 'line-input', type: 'password', value: cfg.token, placeholder: 'Paste the token', autocomplete: 'off' });
  const jql = el('textarea', { class: 'line-input', value: cfg.jql, rows: 2, placeholder: DEFAULT_JQL });
  const count = el('input', { class: 'line-input', type: 'number', min: '1', max: '50', value: String(cfg.count) });
  const emailField = field('Atlassian account email', email);
  const tokenLabel = field('API token', token, 'Made at id.atlassian.com → Security → API tokens. Stored only in this browser, sent only to your Jira site.');
  const syncKind = () => { const cloud = isCloud(site.value.trim()) || !site.value.trim(); emailField.hidden = !cloud; tokenLabel.querySelector('.hint')!.textContent = cloud ? 'Made at id.atlassian.com → Security → API tokens. Stored only in this browser, sent only to your Jira site.' : 'A personal access token from your Jira profile. Stored only in this browser, sent only to your Jira site.'; };
  site.addEventListener('input', syncKind); syncKind();
  body.append(
    el('p', { class: 'muted' }, 'Read-only. Any JQL works: your open issues, a sprint, a filter you saved. Fogar asks Jira from this browser with your token; nothing goes through a Fogar server.'),
    el('div', { class: 'grid-2' }, field('Jira site', site), emailField),
    tokenLabel,
    field('JQL', jql, 'Blank shows your unresolved issues, most recently updated first.'),
    el('div', { class: 'grid-2' }, field('Title', name), field('Show up to', count)),
    setupForm([], async () => {
      let s = site.value.trim(); if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
      try { new URL(s); } catch { ctx.app.toast('The Jira site needs to be a web address.'); return; }
      const cloud = isCloud(s);
      if (!token.value.trim()) { ctx.app.toast('Paste a token first.'); return; }
      if (cloud && !email.value.trim()) { ctx.app.toast('Jira Cloud needs the account email with the API token.'); return; }
      const next: JiraConfig = { ...cfg, name: name.value.trim() || 'Jira', site: s.replace(/\/+$/, ''), auth: cloud ? 'basic' : 'bearer', email: email.value.trim(), token: token.value.trim(), jql: jql.value.trim() || DEFAULT_JQL, count: Math.max(1, Math.min(50, Number(count.value) || 10)) };
      if (!next.endpoint) await ensureOriginPermission(next.site);
      inst.config = { ...next }; await setItem(cacheKey(inst), null); await ctx.save(inst); ctx.remount(inst);
    }, cancellable ? () => ctx.remount(inst) : undefined, 'Show my issues'),
  );
}

export const jira: WidgetDef = {
  type: 'jira', title: 'Jira', description: 'Your issues from any JQL query, with your own API token.', single: false, web: false,
  defaultConfig: () => ({ ...DEFAULT_JIRA_CONFIG() }),
  name: (inst) => inst.config.name || 'Jira',
  async render(body, actions, inst, ctx) {
    const cfg = cfgOf(inst);
    if (!cfg.site || !cfg.token) { setup(body, inst, ctx, false); return; }
    const list = el('div', { class: 'jira' });
    const status = el('p', { class: 'muted small-note' }, 'Loading…');
    body.append(list, status);
    const refresh = el('a', { class: 'link', href: '#', onclick: (e: MouseEvent) => { e.preventDefault(); void load(true); } }, 'Refresh');
    const change = el('a', { class: 'link', href: '#', onclick: (e: MouseEvent) => { e.preventDefault(); setup(body, inst, ctx, true); } }, 'Change');
    const open = el('a', { class: 'link', href: filterUrl(cfg), target: '_blank', rel: 'noopener' }, 'Open in Jira');
    actions.append(el('a', { class: 'ghost small jira-open', href: filterUrl(cfg), target: '_blank', rel: 'noopener' }, 'Open in Jira'));
    const paint = (cache: JiraCache) => {
      clear(list);
      if (!cache.issues.length) list.append(el('p', { class: 'muted empty' }, 'No issues match. Enjoy it.'));
      for (const i of cache.issues) {
        list.append(el('a', { class: 'jira-row', href: i.url, target: '_blank', rel: 'noopener', title: `${i.key} · ${i.type ?? ''}${i.assignee ? ` · ${i.assignee}` : ''}` },
          el('span', { class: 'jira-key' }, i.key),
          el('span', { class: 'jira-sum' }, i.summary),
          el('span', { class: 'jira-status', dataset: { cat: i.category } }, i.status),
          el('span', { class: 'jira-meta' }, [i.type, i.priority ? `${i.priority} priority` : null, i.assignee, i.updated ? `updated ${relTime(i.updated)}` : null].filter(Boolean).join(' · '))));
      }
      clear(status);
      status.append(`${cache.total ?? cache.issues.length} issue${(cache.total ?? cache.issues.length) === 1 ? '' : 's'} · updated ${ago(cache.fetchedAt)} · `, refresh, ' · ', open, ' · ', change);
    };
    const load = async (force: boolean) => {
      try {
        let cache = await getItem<JiraCache | null>(cacheKey(inst), null);
        if (force || !cache || !Array.isArray(cache.issues) || Date.now() - cache.fetchedAt > TTL) {
          status.textContent = 'Asking Jira…';
          const got = await fetchIssues(cfg);
          cache = { fetchedAt: Date.now(), issues: got.issues, total: got.total };
          await setItem(cacheKey(inst), cache);
        }
        paint(cache);
      } catch (err) {
        clear(list); clear(status);
        status.append(`${(err as Error).message} `, refresh, ' · ', change);
      }
    };
    void load(false);
  },
  configure(body, inst, ctx) { setup(body, inst, ctx, true); },
};

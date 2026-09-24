/**
 * Jira, read-only, with the user's own credentials: an Atlassian API token for Jira Cloud (sent as Basic auth
 * with the account email) or a personal access token for Jira Server and Data Center (sent as a Bearer). One
 * JQL query names the issues; the request goes from this browser to the Jira site and nowhere else.
 */
export interface JiraConfig {
  name: string;
  /** https://your-team.atlassian.net, or the address of a self-hosted Jira. */
  site: string;
  auth: 'basic' | 'bearer';
  email: string;
  token: string;
  jql: string;
  count: number;
  /** Test hook: base URL that replaces the site for API calls. Not exposed in the UI. */
  endpoint?: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  /** Jira's three buckets: new (to do), indeterminate (in progress), done. */
  category: string;
  priority?: string;
  type?: string;
  assignee?: string;
  updated: number;
  url: string;
}

export const DEFAULT_JQL = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';
export const DEFAULT_JIRA_CONFIG = (): JiraConfig => ({ name: 'Jira', site: '', auth: 'basic', email: '', token: '', jql: DEFAULT_JQL, count: 10 });

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
export const authHeader = (cfg: JiraConfig) => cfg.auth === 'bearer' ? `Bearer ${cfg.token}` : `Basic ${b64(`${cfg.email}:${cfg.token}`)}`;
export const isCloud = (site: string) => /\.atlassian\.net$/i.test((() => { try { return new URL(site).host; } catch { return ''; } })());
export const filterUrl = (cfg: JiraConfig) => `${cfg.site.replace(/\/+$/, '')}/issues/?jql=${encodeURIComponent(cfg.jql)}`;

const FIELDS = 'summary,status,priority,issuetype,assignee,updated';

function toIssue(raw: any, site: string): JiraIssue {
  const f = raw.fields ?? {};
  return {
    key: String(raw.key), summary: String(f.summary ?? ''), status: String(f.status?.name ?? ''), category: String(f.status?.statusCategory?.key ?? ''),
    priority: f.priority?.name ? String(f.priority.name) : undefined, type: f.issuetype?.name ? String(f.issuetype.name) : undefined,
    assignee: f.assignee?.displayName ? String(f.assignee.displayName) : undefined, updated: Date.parse(f.updated ?? '') || 0,
    url: `${site.replace(/\/+$/, '')}/browse/${raw.key}`,
  };
}

async function explain(res: Response, cfg: JiraConfig): Promise<string> {
  if (res.status === 401) return cfg.auth === 'basic' ? 'Jira rejected the email and API token.' : 'Jira rejected the personal access token.';
  if (res.status === 403) return 'That account may not run this search.';
  try {
    const j = await res.json();
    const msgs = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].map(String);
    if (msgs.length) return msgs.join(' ').slice(0, 200);
  } catch { /* no body */ }
  return `Jira returned ${res.status}.`;
}

/** Jira Cloud's current search endpoint first; the classic one for Server, Data Center, and older sites. */
export async function fetchIssues(cfg: JiraConfig, signal?: AbortSignal): Promise<{ issues: JiraIssue[]; total?: number }> {
  const base = (cfg.endpoint ?? cfg.site).replace(/\/+$/, '');
  const headers = { Authorization: authHeader(cfg), Accept: 'application/json' };
  const max = String(Math.max(1, Math.min(50, cfg.count || 10)));
  const q = new URLSearchParams({ jql: cfg.jql.trim() || DEFAULT_JQL, maxResults: max, fields: FIELDS });
  let res = await fetch(`${base}/rest/api/3/search/jql?${q}`, { headers, signal, cache: 'no-store' });
  if (res.status === 404 || res.status === 410) res = await fetch(`${base}/rest/api/2/search?${q}`, { headers, signal, cache: 'no-store' });
  if (!res.ok) throw new Error(await explain(res, cfg));
  const data = await res.json();
  const issues = ((data.issues ?? []) as any[]).map((i) => toIssue(i, cfg.site));
  return { issues, total: typeof data.total === 'number' ? data.total : undefined };
}

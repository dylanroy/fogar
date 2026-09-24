import type { WidgetType } from './layout';
import { getItem } from './store';

/**
 * Which widgets are part of Pro. The list ships inside the build, so a free install never asks a server what it
 * may show; a signed-in Pro install may later carry a newer copy under `fogar.catalog` (see docs/pro-sync-admin-plan.md).
 * Today every widget is free and nothing in the UI changes; the plumbing is here so flipping one is a data change.
 */
export type Tier = 'free' | 'pro';

export const DEFAULT_TIERS: Record<WidgetType, Tier> = {
  todos: 'free', reminders: 'free', agenda: 'free', sessions: 'free', links: 'free', notes: 'free', weather: 'free', recipe: 'free',
  email: 'free', feed: 'free', notebook: 'free', postit: 'free', chat: 'free', canvas: 'free', jira: 'free', writing: 'free',
};

export const CATALOG_KEY = 'fogar.catalog';
export const PRO_KEY = 'fogar.pro';

export async function loadTiers(): Promise<Record<WidgetType, Tier>> {
  const override = await getItem<Partial<Record<WidgetType, Tier>> | null>(CATALOG_KEY, null);
  return { ...DEFAULT_TIERS, ...(override ?? {}) };
}

/** Pro is a signed-in account with a live subscription; until the account system exists this is always false. */
export async function isPro(): Promise<boolean> {
  const p = await getItem<{ active?: boolean } | null>(PRO_KEY, null);
  return Boolean(p?.active);
}

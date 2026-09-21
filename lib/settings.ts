import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Settings } from './llm/types';

const KEY = 'fogar.settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEY);
  const saved = (stored[KEY] ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...saved, cloud: { ...DEFAULT_SETTINGS.cloud, ...(saved.cloud ?? {}) } };
}

export async function saveSettings(s: Settings): Promise<void> {
  await browser.storage.local.set({ [KEY]: s });
}

/** Cloud endpoints are user-chosen, so their origin is requested as an optional host permission at save time. */
export async function ensureEndpointPermission(endpoint: string): Promise<boolean> {
  try {
    const origin = new URL(endpoint).origin + '/*';
    const has = await browser.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await browser.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

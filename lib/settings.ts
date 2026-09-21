import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Settings } from './llm/types';
import { getItem, setItem } from './store';

const KEY = 'fogar.settings';

export async function loadSettings(): Promise<Settings> {
  const saved = await getItem<Partial<Settings>>(KEY, {});
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    cloud: { ...DEFAULT_SETTINGS.cloud, ...(saved.cloud ?? {}) },
    grounding: { ...DEFAULT_SETTINGS.grounding, ...(saved.grounding ?? {}) },
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  await setItem(KEY, s);
}

/** User-chosen origins (cloud endpoint, search API) are requested as optional host permissions, never listed up front. */
export async function ensureOriginPermission(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin + '/*';
    if (await browser.permissions.contains({ origins: [origin] })) return true;
    return await browser.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

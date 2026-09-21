import { browser } from 'wxt/browser';

/** Thin typed wrapper over extension local storage. Everything Fogar remembers goes through here. */
export async function getItem<T>(key: string, fallback: T): Promise<T> {
  const got = await browser.storage.local.get(key);
  return (got[key] as T | undefined) ?? fallback;
}

export async function setItem<T>(key: string, value: T): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

export function onItemChange<T>(key: string, cb: (value: T | undefined) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && key in changes) cb(changes[key]!.newValue as T | undefined);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

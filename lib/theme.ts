import { getItem, setItem } from './store';

/**
 * A theme is a dozen numbers and words, never CSS. Colors are derived from an accent hue and chroma plus a paper
 * tint, at fixed lightness, so every combination stays readable in light and dark. That is what makes themes
 * safe to share as data.
 */
export type Appearance = 'system' | 'light' | 'dark';
export type Paper = 'warm' | 'neutral' | 'cool';
export interface Theme {
  version: 1;
  appearance: Appearance;
  /** OKLCH hue of the accent, 0 to 360. */
  hue: number;
  /** OKLCH chroma of the accent, 0 to 0.25. */
  chroma: number;
  /** Name of the curated accent this came from, if any. */
  accentName?: string;
  paper: Paper;
  headings: 'serif' | 'sans';
  density: 'comfortable' | 'compact';
}

export const ACCENTS: Array<{ name: string; hue: number; chroma: number }> = [
  { name: 'Ember', hue: 40, chroma: 0.19 },
  { name: 'Moss', hue: 145, chroma: 0.12 },
  { name: 'Ocean', hue: 235, chroma: 0.14 },
  { name: 'Plum', hue: 325, chroma: 0.14 },
  { name: 'Slate', hue: 250, chroma: 0.05 },
  { name: 'Sand', hue: 75, chroma: 0.09 },
];

export const PAPERS: Record<Paper, { hue: number; chroma: number }> = {
  warm: { hue: 75, chroma: 0.012 },
  neutral: { hue: 0, chroma: 0 },
  cool: { hue: 250, chroma: 0.01 },
};

export const DEFAULT_THEME: Theme = { version: 1, appearance: 'system', hue: 40, chroma: 0.19, accentName: 'Ember', paper: 'warm', headings: 'serif', density: 'comfortable' };

export const THEME_KEY = 'fogar.theme';

/** Mirror to localStorage so public/theme-boot.js can paint the right theme before the first frame. */
function mirror(t: Theme): void {
  try { localStorage.setItem(THEME_KEY, JSON.stringify(t)); } catch { /* storage blocked; the async path still applies it */ }
}

export async function loadTheme(): Promise<Theme> {
  const t = validateTheme({ ...DEFAULT_THEME, ...(await getItem<Partial<Theme>>(THEME_KEY, {})) }) ?? { ...DEFAULT_THEME };
  mirror(t);
  return t;
}

export async function saveTheme(t: Theme): Promise<void> {
  await setItem(THEME_KEY, t);
  mirror(t);
}

/** Paint a theme: two attributes and four numbers on the root element. Everything else is CSS. */
export function applyTheme(t: Theme, root: HTMLElement = document.documentElement): void {
  if (t.appearance === 'light' || t.appearance === 'dark') root.dataset.theme = t.appearance;
  else delete root.dataset.theme;
  const paper = PAPERS[t.paper] ?? PAPERS.warm;
  root.style.setProperty('--h', String(t.hue));
  root.style.setProperty('--c', String(t.chroma));
  root.style.setProperty('--ph', String(paper.hue));
  root.style.setProperty('--pc', String(paper.chroma));
  root.dataset.headings = t.headings;
  root.dataset.density = t.density;
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => { const v = Number(n); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback; };
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options as readonly string[]).includes(v as string) ? (v as T) : fallback;

/** Accept anything shaped like a theme from storage, a paste, or a link; clamp the numbers; reject the rest. */
export function validateTheme(raw: unknown): Theme | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    version: 1,
    appearance: oneOf(r.appearance, ['system', 'light', 'dark'] as const, 'system'),
    hue: Math.round(clamp(r.hue, 0, 360, DEFAULT_THEME.hue)),
    chroma: Math.round(clamp(r.chroma, 0, 0.25, DEFAULT_THEME.chroma) * 1000) / 1000,
    accentName: typeof r.accentName === 'string' ? r.accentName.slice(0, 24) : undefined,
    paper: oneOf(r.paper, ['warm', 'neutral', 'cool'] as const, 'warm'),
    headings: oneOf(r.headings, ['serif', 'sans'] as const, 'serif'),
    density: oneOf(r.density, ['comfortable', 'compact'] as const, 'comfortable'),
  };
}

const b64url = {
  enc: (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))),
};
export const encodeThemeShare = (t: Theme): string => b64url.enc(JSON.stringify(t));
export function decodeThemeShare(encoded: string): Theme | null {
  try { return validateTheme(JSON.parse(b64url.dec(encoded))); } catch { return null; }
}

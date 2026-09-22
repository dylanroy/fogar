import type { App } from '../app';
import type { WidgetsUI } from '../widgets';
import { $, clear, el } from '@/lib/dom';
import { ACCENTS, DEFAULT_THEME, applyTheme, encodeThemeShare, saveTheme, type Theme } from '@/lib/theme';
import { DEFAULT_LAYOUT } from '@/lib/layout';

/**
 * Appearance and layout in one popover. Every control is a choice among values the stylesheet already knows
 * how to render; nothing here lets a page become unreadable, and the whole result is data that can be shared.
 */
export function initCustomize(app: App, widgets: WidgetsUI, theme: Theme): void {
  const btn = $('customize-btn'); const menu = $('customize-menu');

  const commitTheme = async () => { applyTheme(theme); await saveTheme(theme); paint(); };
  const seg = <T extends string>(options: Array<[T, string]>, current: T, attr: string, onPick: (v: T) => void) => {
    const wrap = el('span', { class: 'seg', role: 'group' });
    for (const [value, label] of options) {
      wrap.append(el('button', { type: 'button', 'aria-pressed': String(value === current), dataset: { [attr]: value }, onclick: () => onPick(value) } as any, label));
    }
    return wrap;
  };
  const group = (label: string, control: HTMLElement) => el('div', { class: 'cz-group' }, el('span', { class: 'cz-label' }, label), control);

  function paint() {
    clear(menu);
    const L = widgets.layout;
    menu.append(el('div', { class: 'cz-title' }, 'Appearance'));
    menu.append(group('Theme', seg([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], theme.appearance, 'appearance', (v) => { theme.appearance = v; void commitTheme(); })));

    const swatches = el('div', { class: 'swatches', role: 'group', 'aria-label': 'Accent' } as any);
    for (const a of ACCENTS) {
      swatches.append(el('button', {
        type: 'button', class: 'swatch', title: a.name, 'aria-label': `${a.name} accent`, 'aria-pressed': String(theme.accentName === a.name),
        style: `--sh:${a.hue};--sc:${a.chroma}`, dataset: { accent: a.name },
        onclick: () => { theme.hue = a.hue; theme.chroma = a.chroma; theme.accentName = a.name; void commitTheme(); },
      } as any));
    }
    const hue = el('input', { type: 'range', min: '0', max: '360', step: '1', value: String(theme.hue), class: 'hue', 'aria-label': 'Accent hue' } as any);
    // Live preview while dragging; save when the thumb is released.
    hue.oninput = () => { theme.hue = Number(hue.value); theme.chroma = Math.max(theme.chroma, 0.1); theme.accentName = undefined; applyTheme(theme); for (const s of swatches.querySelectorAll('.swatch')) s.setAttribute('aria-pressed', 'false'); };
    hue.onchange = () => void commitTheme();
    menu.append(group('Accent', el('div', { class: 'cz-accent' }, swatches, hue)));

    menu.append(group('Paper', seg([['warm', 'Warm'], ['neutral', 'Neutral'], ['cool', 'Cool']], theme.paper, 'paper', (v) => { theme.paper = v; void commitTheme(); })));
    menu.append(group('Headings', seg([['serif', 'Serif'], ['sans', 'Sans']], theme.headings, 'headings', (v) => { theme.headings = v; void commitTheme(); })));
    menu.append(group('Density', seg([['comfortable', 'Comfortable'], ['compact', 'Compact']], theme.density, 'density', (v) => { theme.density = v; void commitTheme(); })));

    menu.append(el('div', { class: 'cz-title' }, 'Layout'));
    menu.append(group('Ask box', seg([['top', 'Top'], ['centered', 'Centered']], L.ask, 'ask', (v) => void widgets.update({ ask: v }).then(paint))));
    menu.append(group('Wide windows', seg([['stack', 'One column'], ['sidebar', 'Sidebar']], L.arrangement, 'arrangement', (v) => void widgets.update({ arrangement: v }).then(paint))));
    menu.append(group('Widget columns', seg([['auto', 'Auto'], ['2', '2'], ['3', '3']], String(L.columns), 'columns', (v) => void widgets.update({ columns: v === 'auto' ? 'auto' : (Number(v) as 2 | 3) }).then(paint))));
    menu.append(group('Recipes row', seg([['shown', 'Shown'], ['hidden', 'Hidden']], L.showRecipes ? 'shown' : 'hidden', 'recipes', (v) => void widgets.update({ showRecipes: v === 'shown' }).then(paint))));

    menu.append(el('div', { class: 'row-actions cz-foot' },
      el('button', { class: 'ghost small', type: 'button', onclick: async () => {
        await navigator.clipboard.writeText(`${location.origin}/newtab.html?theme=${encodeThemeShare(theme)}`);
        app.toast('Theme link copied. It applies in any browser with Fogar installed.');
      } }, 'Copy theme link'),
      el('button', { class: 'ghost small', type: 'button', dataset: { reset: 'all' }, onclick: async () => {
        Object.assign(theme, DEFAULT_THEME);
        applyTheme(theme); await saveTheme(theme);
        await widgets.update({ ask: DEFAULT_LAYOUT.ask, arrangement: DEFAULT_LAYOUT.arrangement, columns: DEFAULT_LAYOUT.columns, showRecipes: DEFAULT_LAYOUT.showRecipes });
        paint(); app.toast('Back to the defaults. Your widgets are untouched.');
      } }, 'Reset'),
    ));
  }

  btn.onclick = () => { menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) paint(); };
  // composedPath is fixed at dispatch, so a control that repaints itself away mid-click still counts as inside.
  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    const path = e.composedPath();
    if (!path.includes(menu) && !path.includes(btn)) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  });
}

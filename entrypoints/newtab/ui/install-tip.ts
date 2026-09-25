import { $, el } from '@/lib/dom';
import { isWeb } from '@/lib/platform';

const KEY = 'fogar.web.installTip';

/**
 * The web app open in a phone's browser tab: say how to put it on the home screen, once. A home-screen app opens
 * full screen, keeps storage of its own (so the model and the data live in the app, not in the browser's tab), and
 * on iOS is exempt from Safari's seven-day cleanup. Nothing shows inside an installed app, on a desktop, or after
 * the tip is closed.
 */
export function initInstallTip(): void {
  if (!isWeb()) return;
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
  const phone = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
  let closed = false;
  try { closed = localStorage.getItem(KEY) === 'closed'; } catch { /* storage blocked: show it */ }
  if (standalone || !phone || closed) return;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const how = ios ? 'In Safari, tap Share, then Add to Home Screen.' : 'In Chrome, open the menu, then Add to Home screen or Install app.';
  const tip = el('div', { class: 'card install-tip', role: 'note' },
    el('p', {}, el('b', {}, 'Put Fogar on your home screen. '), `${how} Then open it from there: the app keeps its own storage, so set it up inside it, and it works with no connection.`),
    el('button', { class: 'ctl', type: 'button', title: 'Close', 'aria-label': 'Close', onclick: () => { tip.remove(); try { localStorage.setItem(KEY, 'closed'); } catch { /* fine */ } } } as any, '×'));
  $('firstrun').before(tip);
}

import type { App } from '../app';
import { $ } from '@/lib/dom';

/** Three honest choices, once. Everything is still reachable from Settings afterwards. */
export function initFirstRun(app: App): void {
  const card = $('firstrun');
  if (app.settings.onboarded) return;
  card.hidden = false;
  if (app.recommended) {
    const r = app.recommended;
    $('firstrun-rec').textContent = `Downloads ${r.label.replace(/^\w+: /, '')} once (${r.approxMB >= 1000 ? `${(r.approxMB / 1000).toFixed(1)} GB` : `${r.approxMB} MB`}), the right size for this machine. After that nothing you type leaves this browser.`;
  }
  card.querySelectorAll<HTMLButtonElement>('.choice').forEach((btn) => {
    btn.onclick = async () => {
      const choice = btn.dataset.choice;
      app.settings.onboarded = true;
      card.hidden = true;
      if (choice === 'cloud') {
        app.setMode('cloud');
        $<HTMLDetailsElement>('settings').open = true;
        $('cloud-settings').scrollIntoView({ block: 'center' });
        $('cloud-key').focus();
      } else {
        app.setMode('local');
        if (choice === 'local') void app.loadModel();
      }
      await app.save();
    };
  });
}

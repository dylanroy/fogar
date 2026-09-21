import type { App } from '../app';
import { $ } from '@/lib/dom';

/** Three honest choices, once. Everything is still reachable from Settings afterwards. */
export function initFirstRun(app: App): void {
  const card = $('firstrun');
  if (app.settings.onboarded) return;
  card.hidden = false;
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

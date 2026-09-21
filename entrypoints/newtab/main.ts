import { App } from './app';
import { initAskBar } from './ui/askbar';
import { initRecipes } from './ui/recipes';
import { initTodos } from './ui/todos';
import { initReminders } from './ui/reminders';
import { initSettings } from './ui/settings';
import { initFirstRun } from './ui/firstrun';
import { $, el } from '@/lib/dom';

const params = new URLSearchParams(location.search);
const SMOKE = params.get('smoke') === '1'; // automated flows
const E2E = params.get('e2e') === '1'; // marks onboarding done, then waits for the test to drive the page
const INITIAL_QUESTION = params.get('q');
const SHARED_RECIPE = params.get('recipe');

// Rotating footer line. Own products first; a disclosed sponsor slot comes later, and only with real usage.
const PROMO: Array<[label: string, href: string]> = [
  ['UseSQL: run SQL across Google Sheets, APIs and files', 'https://www.usesql.com/?ref=fogar'],
  ['TickerPal: stock prices on demand in Slack', 'https://tickerpal.com/?ref=fogar'],
  ['Kumkuat: know how every audience reacts before you say a word', 'https://kumkuat.ai/?ref=fogar'],
  ['Read how Fogar was built', 'https://dylanroy.com/?ref=fogar'],
];

async function main() {
  const app = new App();
  await app.init();
  const s = app.settings;

  if (SMOKE || E2E) {
    s.onboarded = true; s.autoLoad = false;
    if (SMOKE) {
      s.mode = 'local'; s.modelId = params.get('model') ?? 'smoke'; s.gpu = params.get('gpu') === '1';
      const cloudPort = params.get('cloud');
      if (cloudPort) { s.mode = 'cloud'; s.cloud = { endpoint: `http://127.0.0.1:${cloudPort}/v1`, apiKey: 'test-key', model: 'mock-model' }; }
      const groundPort = params.get('ground');
      s.grounding = groundPort
        ? { provider: 'brave', apiKey: 'test-key', byDefault: true, endpoint: `http://127.0.0.1:${groundPort}/brave` }
        : { provider: 'none', apiKey: '', byDefault: true };
    }
  }

  $('today').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const [label, href] = PROMO[Math.floor(Math.random() * PROMO.length)]!;
  $('promo').append(el('a', { href, target: '_blank', rel: 'noopener' }, label));

  initSettings(app);
  initAskBar(app);
  const recipes = initRecipes(app);
  initTodos(app);
  initReminders(app);
  initFirstRun(app);
  app.setMode(s.mode);

  if (INITIAL_QUESTION) $<HTMLTextAreaElement>('prompt').value = `Explain this: “${INITIAL_QUESTION}”`;
  if (SHARED_RECIPE) recipes.offerShared(SHARED_RECIPE);

  if (SMOKE) {
    const recipe = params.get('recipe_run');
    if (s.mode === 'cloud') {
      if (recipe) await recipes.runBuiltin(recipe, { text: 'hello there friend', tone: 'Formal', length: 'Shorter', format: 'Email' });
      else await app.askQuestion(params.get('ground') ? 'Who is the US president?' : 'Say hello', Boolean(params.get('ground')));
      return;
    }
    if (await app.loadModel()) await app.askQuestion('Once upon a time', false);
    return;
  }
  if (E2E) return;

  // New tab after the first successful load: bring the cached model up without a click.
  if (s.mode === 'local' && s.autoLoad && s.onboarded) await app.loadModel();
  if (INITIAL_QUESTION && app.isReady()) void app.askQuestion($<HTMLTextAreaElement>('prompt').value, false);
}

void main();

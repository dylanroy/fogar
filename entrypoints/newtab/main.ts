import { App } from './app';
import { initAskBar } from './ui/askbar';
import { initRecipes } from './ui/recipes';
import { createTodosUI } from './ui/todos';
import { createRemindersUI } from './ui/reminders';
import { initWidgets } from './widgets';
import { initSettings } from './ui/settings';
import { initFirstRun } from './ui/firstrun';
import { $, el } from '@/lib/dom';
import { detectDevice, recommendModel } from '@/lib/device';
import { browser } from 'wxt/browser';
import { CTX_KEY, type PageContext } from '@/lib/page-context';

const params = new URLSearchParams(location.search);
const SMOKE = params.get('smoke') === '1'; // automated flows
const E2E = params.get('e2e') === '1'; // marks onboarding done, then waits for the test to drive the page
const INITIAL_QUESTION = params.get('q');
const CTX_ID = params.get('ctx'); // set by the background worker for a right-click question
const SHARED_RECIPE = params.get('recipe');
const EVAL = params.get('eval') === '1'; // model quality and speed harness, see scripts/eval-models.mjs

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
  app.device = await detectDevice();
  app.recommended = recommendModel(app.device);
  // Until the user has chosen, follow the machine: the default model id is only a placeholder.
  if (!s.onboarded) s.modelId = app.recommended.id;

  if (EVAL) { await runEval(app); return; }
  if (SMOKE || E2E) {
    s.onboarded = true; s.autoLoad = false;
    const cloudPort = params.get('cloud');
    if (cloudPort) { s.mode = 'cloud'; s.cloud = { endpoint: `http://127.0.0.1:${cloudPort}/v1`, apiKey: 'test-key', model: 'mock-model' }; }
    const altCloud = params.get('altcloud'); // cloud configured but not selected, for the "Ask the cloud model" path
    if (altCloud) s.cloud = { endpoint: `http://127.0.0.1:${altCloud}/v1`, apiKey: 'test-key', model: 'mock-model' };
    const groundPort = params.get('ground'); const freePort = params.get('freeground');
    s.grounding = groundPort
      ? { provider: 'brave', apiKey: 'test-key', byDefault: params.get('groundoff') !== '1', endpoint: `http://127.0.0.1:${groundPort}/brave` }
      : freePort
        ? { provider: 'free', apiKey: '', byDefault: true, endpoint: `http://127.0.0.1:${freePort}` }
        : { provider: 'none', apiKey: '', byDefault: true };
    if (SMOKE && !cloudPort) { s.mode = 'local'; s.modelId = params.get('model') ?? 'smoke'; s.gpu = params.get('gpu') === '1'; }
  }

  $('today').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const [label, href] = PROMO[Math.floor(Math.random() * PROMO.length)]!;
  $('promo').append(el('a', { href, target: '_blank', rel: 'noopener' }, label));

  initSettings(app);
  const recipes = initRecipes(app);
  const todos = createTodosUI(app);
  const reminders = createRemindersUI(app);
  await initWidgets(app, { recipes, todos, reminders });
  initAskBar(app, { todos, reminders, recipes });
  initFirstRun(app);
  app.setMode(s.mode);

  // A right-click question arrives with the page it came from. The selection may already carry quotes; do not add more.
  let pageContext: PageContext | null = null;
  if (CTX_ID) {
    const key = CTX_KEY(CTX_ID);
    pageContext = ((await browser.storage.session.get(key))[key] as PageContext | undefined) ?? null;
    if (pageContext) void browser.storage.session.remove(key);
  }
  const selection = (pageContext?.selection ?? INITIAL_QUESTION ?? '').trim().replace(/^["“”'‘’«»]+|["“”'‘’«»]+$/g, '').trim();
  if (selection) $<HTMLTextAreaElement>('prompt').value = `Explain this: “${selection}”`;
  if (SHARED_RECIPE) recipes.offerShared(SHARED_RECIPE);

  if (SMOKE) {
    const recipe = params.get('recipe_run');
    if (s.mode === 'cloud') {
      if (recipe) await recipes.runBuiltin(recipe, { text: 'hello there friend', tone: 'Formal', length: 'Shorter', format: 'Email' });
      else { const grounded = Boolean(params.get('ground') || params.get('freeground')); await app.askQuestion(grounded ? 'Who is the US president?' : 'Say hello', { ground: grounded }); }
      return;
    }
    if (await app.loadModel()) await app.askQuestion('Once upon a time');
    return;
  }
  if (E2E) return;

  // New tab after the first successful load: bring the cached model up without a click.
  if (s.mode === 'local' && s.autoLoad && s.onboarded) await app.loadModel();
  if (selection && app.isReady()) { const q = $<HTMLTextAreaElement>('prompt').value; $<HTMLTextAreaElement>('prompt').value = ''; void app.askQuestion(q, { context: pageContext }); }
}

/** Runs a fixed prompt set against one model and reports timings and outputs as JSON for scripts/eval-models.mjs. */
async function runEval(app: App) {
  const s = app.settings;
  s.onboarded = true; s.mode = 'local'; s.modelId = params.get('model') ?? 'qwen3.5-0.8b'; s.gpu = params.get('gpu') === '1';
  initSettings(app); const recipes = initRecipes(app); const todos = createTodosUI(app); const reminders = createRemindersUI(app); await initWidgets(app, { recipes, todos, reminders }); initAskBar(app, { todos, reminders, recipes }); app.setMode('local');
  const think = params.get('think') === '1';
  const out: any = { model: s.modelId, gpu: s.gpu, think, results: [] as any[] };
  const t0 = performance.now();
  const ok = await app.loadModel();
  out.loadMs = Math.round(performance.now() - t0);
  out.loaded = ok; out.cpuFallback = app.local.fellBackToCpu;
  const DEFAULT_SYS = 'You are Fogar, a concise assistant running in the user\'s browser. Answer directly, in plain language.';
  const PROMPTS: Array<[string, string, string?]> = [
    ['rewrite', 'Rewrite the text below.\nTone: Friendly. Length: About the same. Format: Chat message.\nKeep the meaning and any specific facts, names, and numbers.\n\nText:\ncant make 3pm, thurs instead? sorry', 'You are a careful writing assistant. Return only the rewritten text, with no preamble and no commentary.'],
    ['summary', 'Summarize in exactly three short bullets:\n\nThe team shipped the spike on Monday. WebGPU offload works on Apple silicon and the model caches in OPFS so a warm start takes about a second. The Chrome Web Store listing is next, after a privacy page and screenshots. Firefox is deferred because its extension pages lack SharedArrayBuffer.'],
    ['fact', 'Who is the current president of the United States? If you are not sure, say so in one sentence.'],
    ['math', 'What is 18% of 240? Answer with just the number.'],
    ['classify', 'You sort bookmarks. Reply with only the numbers of the items that are job postings, comma separated, or NONE.\n\nCriterion: job postings\n\n1. Senior Backend Engineer | Acme Careers (acme.com)\n2. How to cook risotto (seriouseats.com)\n3. Staff Engineer, Platform - Globex (jobs.lever.co)\n4. React docs (react.dev)\n5. Weekend hikes near Denver (alltrails.com)\n6. Data Analyst opening at Initech (greenhouse.io)'],
    ['extract', 'Extract a JSON object with keys label and datetime (ISO 8601) from: "remind me to call the dentist tomorrow at 9am". Today is 2026-09-21T16:00:00. Return only JSON.'],
  ];
  if (ok) {
    for (const [name, prompt, sys] of PROMPTS) {
      const t1 = performance.now(); let first = 0; let text = ''; let tokens = 0; let reasoning = '';
      try {
        for await (const tok of app.local.ask([{ role: 'system', content: sys ?? DEFAULT_SYS }, { role: 'user', content: prompt }], new AbortController().signal, { maxTokens: think ? 1500 : 300, think, onReasoning: (r) => { reasoning += r; } })) {
          if (!first) first = performance.now(); tokens++; text += tok;
        }
      } catch (err) { text = `ERROR: ${(err as Error).message}`; }
      const total = performance.now() - t1;
      out.results.push({ name, firstTokenMs: Math.round(first ? first - t1 : total), tokPerSec: tokens > 1 && first ? +(tokens / ((total - (first - t1)) / 1000)).toFixed(1) : null, tokens, reasoningChars: reasoning.length, reasoningHead: reasoning.slice(0, 160), text: text.trim().slice(0, 400) });
    }
  } else {
    out.error = $('status').textContent;
  }
  $('eval-out').textContent = JSON.stringify(out);
  document.body.dataset.status = 'done';
}

void main();

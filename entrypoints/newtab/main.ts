import { DEFAULT_SETTINGS } from '@/lib/llm/types';
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
import { applyTheme, decodeThemeShare, loadTheme, saveTheme } from '@/lib/theme';
import { ATTACHMENT_BUDGET, attachmentBlock, type Attachment } from '@/lib/attachments';
import { initCustomize } from './ui/customize';

const params = new URLSearchParams(location.search);
const SMOKE = params.get('smoke') === '1'; // automated flows
const E2E = params.get('e2e') === '1'; // marks onboarding done, then waits for the test to drive the page
const INITIAL_QUESTION = params.get('q');
const CTX_ID = params.get('ctx'); // set by the background worker for a right-click question
const SHARED_RECIPE = params.get('recipe');
const SHARED_THEME = params.get('theme');
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
  // The boot script already painted the mirrored theme; this corrects it from the source of truth.
  const theme = await loadTheme();
  if (SHARED_THEME) {
    const shared = decodeThemeShare(SHARED_THEME);
    if (shared) { Object.assign(theme, shared); await saveTheme(theme); }
  }
  applyTheme(theme);
  const releaseMs = params.get('releasems'); if (releaseMs) app.releaseAfterMs = Number(releaseMs); // test hook
  const s = app.settings;
  app.device = await detectDevice();
  app.recommended = recommendModel(app.device);
  // Until the user has chosen, follow the machine: the default model id is only a placeholder.
  if (!s.onboarded) s.modelId = app.recommended.id;

  if (EVAL) { await runEval(app); return; }
  if (SMOKE || E2E) {
    s.onboarded = true; if (params.get('autoload') !== '1') s.autoLoad = false;
    const cloudPort = params.get('cloud');
    if (cloudPort) { s.mode = 'cloud'; s.cloud = { endpoint: `http://127.0.0.1:${cloudPort}/v1`, apiKey: 'test-key', model: 'mock-model' }; }
    const altCloud = params.get('altcloud'); // cloud configured but not selected, for the "Ask the cloud model" path
    if (altCloud) s.cloud = { endpoint: `http://127.0.0.1:${altCloud}/v1`, apiKey: 'test-key', model: 'mock-model' };
    const groundPort = params.get('ground'); const freePort = params.get('freeground');
    s.grounding = groundPort
      ? { provider: 'brave', apiKey: 'test-key', byDefault: params.get('groundoff') !== '1', endpoint: `http://127.0.0.1:${groundPort}/brave` }
      : freePort
        ? { provider: 'free', apiKey: '', byDefault: true, endpoint: `http://127.0.0.1:${freePort}` }
        : { ...DEFAULT_SETTINGS.grounding }; // no test parameter: the real default, so tests see what users see
    if (SMOKE && !cloudPort) { s.mode = 'local'; s.modelId = params.get('model') ?? 'smoke'; s.gpu = params.get('gpu') === '1'; }
  }

  $('today').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const [label, href] = PROMO[Math.floor(Math.random() * PROMO.length)]!;
  $('promo').append(el('a', { href, target: '_blank', rel: 'noopener' }, label));

  initSettings(app);
  const recipes = initRecipes(app);
  const todos = createTodosUI(app);
  const reminders = createRemindersUI(app);
  const widgets = await initWidgets(app, { recipes, todos, reminders });
  initCustomize(app, widgets, theme);
  initAskBar(app, { todos, reminders, recipes });
  initFirstRun(app);
  app.setMode(s.mode);
  if (SHARED_THEME) app.toast(decodeThemeShare(SHARED_THEME) ? 'Theme applied from the link. Open Customize to change it.' : 'That theme link is not valid.');

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

  // A new tab loads nothing by itself. The cached model comes up on intent (typing, a recipe, a question);
  // see App.ensureModel. A right-click question is intent.
  if (selection && app.canAnswer()) { const q = $<HTMLTextAreaElement>('prompt').value; $<HTMLTextAreaElement>('prompt').value = ''; void app.askQuestion(q, { context: pageContext }); }
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
    // A two-page letter (915 words) in front of the model, the way an attached file arrives. First-token time here is the
    // cost of reading a document; the answer checks that the facts near the end survived.
    ['document', 'Who sent the irrigation invoice, how much is it, and when is it due? Answer in one sentence.', `${DEFAULT_SYS}\n\n${attachmentBlock([evalDocument()], ATTACHMENT_BUDGET.local)}`],
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

/** A synthetic two-page letter of 915 words, under the local attachment budget, with the facts the eval asks for near the end. */
function evalDocument(): Attachment {
  const filler = [
    'The board met on the second Tuesday of the month to review the quarter.',
    'Attendance was complete, and the minutes of the previous meeting were approved without amendment.',
    'The facilities report noted that the roof repair on the north building finished ahead of schedule.',
    'Membership renewals came in slightly above the forecast, driven by the family tier.',
    'The treasurer presented the cash position and the outstanding invoices, none of which were overdue.',
    'A proposal to move the newsletter to a quarterly cadence was tabled for the next meeting.',
    'The volunteer coordinator reported forty-two active volunteers, up from thirty-eight in the spring.',
    'Two grant applications remain open; decisions are expected before the end of the year.',
  ];
  const paras = ['Riverside Community Garden Association', "Minutes and treasurer's letter, autumn quarter"];
  for (let i = 0; i < 20; i++) paras.push(`${filler[i % filler.length]} ${filler[(i * 3 + 1) % filler.length]} ${filler[(i * 5 + 2) % filler.length]}`);
  paras.push('Payment request: the irrigation contractor, Hollis & Vane, has invoiced 4,850 dollars for the drip lines, due on November 14. The treasurer recommends paying it from the maintenance reserve.');
  paras.push('Next meeting: December 9, in the potting shed, at 7 pm.');
  const text = paras.join('\n\n');
  const words = text.split(/\s+/).length;
  return { id: 'eval', name: 'minutes.txt', kind: 'text', text, words, wordsKept: words, truncated: false };
}

void main();

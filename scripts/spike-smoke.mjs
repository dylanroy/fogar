// End-to-end test. Loads the built extension into Chromium and drives every feature:
//   1. local model: download, load, stream (1 MB test model by default; MODEL=qwen3-0.6b for the real one)
//   2. warm reload served from OPFS with zero GGUF downloads
//   3. cloud mode against a local mock OpenAI server (SSE parser, bearer header)
//   4. web grounding against a mock Brave endpoint (snippets reach the model, sources render, citation shows)
//   5. built-in recipe run (template filled, system prompt applied)
//   6. todos persist across reload
//   7. reminders parse, confirm, save, and create a chrome.alarms entry
//   8. bookmark search as you type
// Usage: npm run test:spike   (HEADED=1 to watch, GPU=1 for WebGPU, VERBOSE=1 for all console lines)
// The suite builds its own test variant (WXT_E2E=1 → .output-e2e) with a host permission for the mock server, so
// the right-click page-context path can run for real. The store build in .output is untouched.
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startMockServer } from './mock-openai.mjs';

if (process.env.SKIP_BUILD !== '1') {
  const build = spawnSync('npx', ['wxt', 'build'], { stdio: 'inherit', env: { ...process.env, WXT_E2E: '1' } });
  if (build.status !== 0) { console.error('e2e build failed'); process.exit(1); }
}
const ext = resolve('.output-e2e/chrome-mv3');
const userDataDir = mkdtempSync(join(tmpdir(), 'fogar-smoke-'));
const headless = process.env.HEADED !== '1';
const gpu = process.env.GPU === '1' ? '1' : '0';
const model = process.env.MODEL || 'smoke';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium', headless, acceptDownloads: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--enable-unsafe-webgpu'],
});
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
const page = await context.newPage();
const logs = [];
let hfResponses = 0; let ggufDownloads = 0;
page.on('response', (r) => {
  const url = r.url();
  if (!/huggingface|hf\.co/.test(url)) return;
  hfResponses++;
  if (r.request().method() === 'GET' && r.status() === 200 && /\.gguf/.test(url)) ggufDownloads++;
});
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const mock = await startMockServer();
const base = `chrome-extension://${extId}/newtab.html`;
const waitDone = (timeout) => page.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.status ?? ''), null, { timeout });
const status = () => page.evaluate(() => document.body.dataset.status);
const text = (id) => page.evaluate((i) => document.getElementById(i)?.textContent ?? '', id);

// 1. local model
let t0 = Date.now();
await page.goto(`${base}?smoke=1&gpu=${gpu}&model=${model}`);
try { await waitDone(600000); } catch { logs.push('[smoke] timed out'); }
const answer = await text('answer');
check('local model streams an answer', (await status()) === 'done' && answer.length > 0, `${Date.now() - t0} ms, ${await text('stats')}`);
console.log(`      status: ${await text('status')}`);
console.log(`      answer: ${answer.slice(0, 120).replace(/\n/g, ' ')}`);

// 2. warm reload
const coldDownloads = ggufDownloads; ggufDownloads = 0; hfResponses = 0; t0 = Date.now();
await page.reload();
try { await waitDone(120000); } catch { /* fall through */ }
check('warm reload serves the model from OPFS', (await status()) === 'done' && ggufDownloads === 0, `${Date.now() - t0} ms, ${coldDownloads} cold GGUF downloads, ${ggufDownloads} warm, ${hfResponses} HF responses`);

// 2b. lazy load: with auto-load on, an idle new tab loads nothing; typing a question loads; a hidden tab releases
await page.goto(`${base}?e2e=1`);
await page.waitForSelector('#recipe-chips .chip');
await page.evaluate(async () => { const got = await chrome.storage.local.get('fogar.settings'); await chrome.storage.local.set({ 'fogar.settings': { ...(got['fogar.settings'] ?? {}), mode: 'local', modelId: 'smoke', autoLoad: true, onboarded: true } }); });
await page.goto(`${base}?e2e=1&autoload=1&releasems=700`);
await page.waitForSelector('#recipe-chips .chip');
await page.waitForTimeout(1200);
const idle = await page.evaluate(() => ({ status: document.body.dataset.status, text: document.getElementById('status').textContent ?? '', askEnabled: !document.getElementById('ask-btn').disabled }));
await page.fill('#prompt', 'hello there friend');
await page.waitForFunction(() => document.body.dataset.status === 'ready', null, { timeout: 60000 });
const warmText = await text('status');
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForFunction(() => /loads when you start typing/.test(document.getElementById('status').textContent ?? ''), null, { timeout: 10000 }).catch(() => {});
const released = await text('status');
check('lazy load: idle tab loads nothing, typing loads, hidden tab releases', idle.status === 'idle' && /loads when you start typing/.test(idle.text) && idle.askEnabled && /^Ready/.test(warmText) && /loads when you start typing/.test(released), `idle="${idle.text.slice(0, 44)}" warm="${warmText.slice(0, 30)}" released=${/loads when/.test(released)}`);

// 3. cloud mode
await page.goto(`${base}?smoke=1&cloud=${mock.port}`);
try { await waitDone(30000); } catch { /* fall through */ }
const cloudAnswer = await text('answer');
check('cloud mode streams via SSE with bearer auth', (await status()) === 'done' && cloudAnswer.includes('mock cloud says hello') && mock.server.lastRequest?.auth === 'Bearer test-key' && mock.server.lastRequest?.stream === true, cloudAnswer);

// 3a. the network ledger saw exactly the cloud host, and the prompt cleared
const ledger = await page.evaluate(() => [...document.querySelectorAll('#ledger-list li')].map((li) => li.textContent));
const pill = await text('ledger-pill');
check('network ledger counts the cloud host', ledger.some((l) => l.includes('127.0.0.1')) && /network: [1-9]/.test(pill), `${pill}; ${ledger.join(' | ')}`);

// 3b. follow-up: the second question carries the first exchange
await page.fill('#prompt', 'Say it again');
await page.press('#prompt', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('#thread .answer-card').length === 2 && document.body.dataset.status === 'done', null, { timeout: 30000 });
const followMsgs = mock.server.lastRequest?.messages ?? [];
check('follow-up keeps the conversation', followMsgs.length === 4 && followMsgs[2]?.role === 'assistant' && /mock cloud says hello/.test(followMsgs[2]?.content ?? '') && followMsgs[3]?.content === 'Say it again', `${followMsgs.length} messages sent; ${await page.evaluate(() => document.querySelectorAll('#thread .answer-card.past').length)} collapsed card(s)`);

// 3c. markdown renders as elements, never raw asterisks
await page.fill('#prompt', 'markdown test please');
await page.press('#prompt', 'Enter');
await page.waitForFunction(() => document.body.dataset.status === 'done' && document.querySelector('#answer strong') !== null, null, { timeout: 30000 });
const md = await page.evaluate(() => ({ strong: document.querySelector('#answer strong')?.textContent, items: document.querySelectorAll('#answer li').length, h: document.querySelector('#answer h5')?.textContent, code: document.querySelector('#answer code')?.textContent, raw: document.getElementById('answer')?.textContent ?? '' }));
check('markdown renders (heading, list, bold, code)', md.strong === 'one' && md.items === 2 && md.h === 'Title' && md.code === 'code' && !md.raw.includes('**'), JSON.stringify(md).slice(0, 120));

// 3d. Dig deeper → "Search the web and answer again": grounded re-ask replaces the ungrounded exchange
await page.goto(`${base}?e2e=1&cloud=${mock.port}&ground=${mock.port}&groundoff=1`);
await page.fill('#prompt', 'Who is the US president?');
await page.press('#prompt', 'Enter');
await waitDone(30000);
const ungroundedSources = await page.evaluate(() => document.querySelectorAll('#sources li').length);
await page.click('#answer-card .dig-btn');
const digItems = await page.evaluate(() => [...document.querySelectorAll('#answer-card .dig-menu .menu-item strong')].map((n) => n.textContent));
await page.click('#answer-card .dig-menu .menu-item:has-text("Search the web and answer again")');
await page.waitForFunction(() => document.querySelectorAll('#thread .answer-card').length === 2 && document.body.dataset.status === 'done', null, { timeout: 30000 });
const regroundedSources = await page.evaluate(() => document.querySelectorAll('#sources li').length);
const digMsgs = mock.server.lastRequest?.messages ?? [];
const superseded = !digMsgs.some((m) => /mock cloud says hello/.test(m.content));
check('dig deeper: search again grounds the re-ask and replaces the old exchange', ungroundedSources === 0 && regroundedSources === 2 && superseded && digItems.includes('Search the web and answer again'), `menu: ${digItems.join(' / ')}; sources ${ungroundedSources}→${regroundedSources}; old answer dropped=${superseded}`);

// 3e. Dig deeper → "Ask the cloud model" from a local answer (cloud configured but not selected)
await page.goto(`${base}?smoke=1&model=smoke&altcloud=${mock.port}`);
await waitDone(120000);
const localAnswer = await text('answer');
await page.click('#answer-card .dig-btn');
const localItems = await page.evaluate(() => [...document.querySelectorAll('#answer-card .dig-menu .menu-item strong')].map((n) => n.textContent));
await page.click('#answer-card .dig-menu .menu-item:has-text("Ask the cloud model")');
await page.waitForFunction(() => document.querySelectorAll('#thread .answer-card').length === 2 && document.body.dataset.status === 'done', null, { timeout: 30000 });
const cloudLabel = await text('answer-label');
const cloudReask = mock.server.lastRequest?.messages ?? [];
check('dig deeper: ask the cloud model re-asks the same question there', cloudLabel === 'Cloud answer' && cloudReask.at(-1)?.content === 'Once upon a time' && !cloudReask.some((m) => m.content === localAnswer) && !localItems.includes('Think longer') /* the smoke model cannot think */ && (await text('status')).includes('Smoke test'), `menu: ${localItems.join(' / ')}; label ${cloudLabel}`);

// 3f. keyless grounding: DuckDuckGo instant answer + Wikipedia, entity query, dedupe by URL, attribution
await page.goto(`${base}?smoke=1&cloud=${mock.port}&freeground=${mock.port}`);
try { await waitDone(30000); } catch { /* fall through */ }
const freeUser = mock.server.lastRequest?.messages?.find((m) => m.role === 'user')?.content ?? '';
const freeSources = await page.evaluate(() => [...document.querySelectorAll('#sources li')].map((li) => li.textContent ?? ''));
check('keyless grounding: DuckDuckGo + Wikipedia, no key, deduped, attributed',
  (await status()) === 'done' && freeUser.includes('MOCK DDG ABSTRACT') && freeUser.includes('MOCK WIKI EXTRACT') && !freeUser.includes('MOCK WIKI SECOND') && !freeUser.includes('Category')
    && freeSources.length === 4 && /DuckDuckGo · Wikipedia/.test(freeSources[0]) && /Wikipedia$/.test(freeSources[1]) && mock.server.lastFree?.ddgQ === 'the US president' && mock.server.lastFree?.wikiQ === 'the US president',
  `${freeSources.length} sources; q="${mock.server.lastFree?.wikiQ}"; first="${freeSources[0]?.slice(0, 50)}"`);

// 3g. defaults on a fresh install: free provider, toggle visible and unticked, no key field.
// Earlier smoke runs persisted their own grounding overrides into this profile, so start from no settings at all.
await page.goto(`${base}?e2e=1`);
await page.waitForSelector('#recipe-chips .chip');
await page.evaluate(() => chrome.storage.local.remove('fogar.settings'));
await page.goto(`${base}?e2e=1`);
await page.waitForSelector('#recipe-chips .chip');
await page.waitForSelector('#ground-toggle:not([hidden])', { timeout: 5000 }).catch(() => {});
const toggleState = await page.evaluate(() => ({ visible: !document.getElementById('ground-toggle').hidden, checked: document.getElementById('ground').checked, keyHidden: document.getElementById('ground-key-label').hidden, provider: document.getElementById('ground-provider').value }));
check('grounding defaults: toggle visible and unticked, free provider, no key field', toggleState.visible && !toggleState.checked && toggleState.keyHidden && toggleState.provider === 'free', JSON.stringify(toggleState));

// 4. grounding
await page.goto(`${base}?smoke=1&cloud=${mock.port}&ground=${mock.port}`);
try { await waitDone(30000); } catch { /* fall through */ }
const userMsg = mock.server.lastRequest?.messages?.find((m) => m.role === 'user')?.content ?? '';
const sysMsg = mock.server.lastRequest?.messages?.find((m) => m.role === 'system')?.content ?? '';
const sourceCount = await page.evaluate(() => document.querySelectorAll('#sources li').length);
check('grounding: snippets reach the model and sources render',
  (await status()) === 'done' && userMsg.includes('MOCK SNIPPET ALPHA') && userMsg.includes('Question: Who is the US president?') && sysMsg.includes('Cite') && sourceCount === 2 && mock.server.lastSearch?.q === 'Who is the US president?' && mock.server.lastSearch?.token === 'test-key',
  `${sourceCount} sources, search q="${mock.server.lastSearch?.q}"`);

// 5. recipe
await page.goto(`${base}?smoke=1&cloud=${mock.port}&recipe_run=rewrite`);
try { await waitDone(30000); } catch { /* fall through */ }
const recipeUser = mock.server.lastRequest?.messages?.find((m) => m.role === 'user')?.content ?? '';
const recipeSys = mock.server.lastRequest?.messages?.find((m) => m.role === 'system')?.content ?? '';
check('recipe: template filled and system prompt applied',
  (await status()) === 'done' && recipeUser.includes('Tone: Formal') && recipeUser.includes('Format: Email') && recipeUser.includes('hello there friend') && recipeSys.includes('Return only the rewritten text') && (await text('answer-label')) === 'Draft & rewrite',
  recipeUser.split('\n')[1]);

// 5b. ask-bar routing: arithmetic, todo capture, reminder capture
await page.goto(`${base}?e2e=1`);
await page.fill('#prompt', 'what is 18% of 240?');
await page.press('#prompt', 'Enter');
await page.waitForSelector('#answer .big');
const calcText = await page.evaluate(() => document.querySelector('#answer .big')?.textContent);
check('arithmetic is computed locally', calcText === '43.2' && (await text('answer-label')) === 'Calculator', `${calcText}`);
await page.fill('#prompt', 'todo: buy oat milk');
await page.press('#prompt', 'Enter');
await page.waitForFunction(() => [...document.querySelectorAll('#todo-list .item .text')].some((n) => n.textContent === 'buy oat milk'), null, { timeout: 5000 });
const promptCleared = await page.evaluate(() => document.getElementById('prompt').value === '');
check('"todo:" in the ask bar adds a todo', promptCleared);
await page.fill('#prompt', 'remind me to call mom at 6pm');
await page.press('#prompt', 'Enter');
await page.waitForSelector('#reminder-confirm:not([hidden])');
const captured = await text('reminder-confirm');
check('"remind me" in the ask bar opens the reminder confirm', captured.includes('“call mom”'), captured.split('?')[0]);

// 6. todos
await page.goto(`${base}?e2e=1`);
await page.fill('#todo-input', 'Write the Fogar blog post');
await page.press('#todo-input', 'Enter');
await page.waitForSelector('#todo-list .item');
await page.reload();
await page.waitForSelector('#todo-list .item');
const todoText = await page.evaluate(() => document.querySelector('#todo-list .item .text')?.textContent);
check('todos persist across reload', todoText === 'Write the Fogar blog post', todoText);

// 6b. edit a todo in place: Enter saves and persists; Escape cancels; emptying it keeps the old text
await page.click('#todo-list .item .text');
await page.waitForSelector('#todo-list .item input.edit');
await page.fill('#todo-list .item input.edit', 'Write blog post one');
await page.press('#todo-list .item input.edit', 'Enter');
await page.waitForFunction(() => document.querySelector('#todo-list .item .text')?.textContent === 'Write blog post one');
await page.reload();
await page.waitForSelector('#todo-list .item .text');
const edited = await page.evaluate(() => document.querySelector('#todo-list .item .text')?.textContent);
await page.click('#todo-list .item .text');
await page.fill('#todo-list .item input.edit', 'should be discarded');
await page.press('#todo-list .item input.edit', 'Escape');
await page.waitForSelector('#todo-list .item .text');
const afterEscape = await page.evaluate(() => document.querySelector('#todo-list .item .text')?.textContent);
await page.click('#todo-list .item .text');
await page.fill('#todo-list .item input.edit', '');
await page.press('#todo-list .item input.edit', 'Enter');
await page.waitForSelector('#todo-list .item .text');
const afterEmpty = await page.evaluate(() => document.querySelector('#todo-list .item .text')?.textContent);
check('todos edit in place: Enter saves, Escape cancels, empty keeps the old text', edited === 'Write blog post one' && afterEscape === 'Write blog post one' && afterEmpty === 'Write blog post one', `${edited} / ${afterEscape} / ${afterEmpty}`);

// 7. reminders
await page.fill('#reminder-input', 'remind me to stretch in 5 minutes');
await page.press('#reminder-input', 'Enter');
await page.waitForSelector('#reminder-confirm:not([hidden])');
const confirmText = await text('reminder-confirm');
await page.click('#reminder-confirm .primary');
await page.waitForSelector('#reminder-list .item');
const reminderRow = await page.evaluate(() => document.querySelector('#reminder-list .item')?.textContent ?? '');
const alarms = await page.evaluate(() => chrome.alarms.getAll());
check('reminder parsed, confirmed, saved, alarm created', confirmText.includes('“stretch”') && reminderRow.includes('stretch') && alarms.some((a) => a.name.startsWith('fogar-reminder:')), `${alarms.length} alarm(s); "${confirmText.split('?')[0]}"`);

// 7b. a second reminder right after the first (reported as failing)
await page.fill('#reminder-input', 'water the plants tomorrow at 9am');
await page.press('#reminder-input', 'Enter');
await page.waitForSelector('#reminder-confirm:not([hidden])');
await page.click('#reminder-confirm .primary');
await page.waitForFunction(() => document.querySelectorAll('#reminder-list .item').length === 2, null, { timeout: 5000 }).catch(() => {});
const reminderCount = await page.evaluate(() => document.querySelectorAll('#reminder-list .item').length);
const alarms2 = await page.evaluate(() => chrome.alarms.getAll());
check('second reminder saves and gets its own alarm', reminderCount === 2 && alarms2.filter((a) => a.name.startsWith('fogar-reminder:')).length === 2, `${reminderCount} rows, ${alarms2.length} alarms`);

// 7c. an alarm actually fires: write a reminder due in 3 s straight to storage (the background reconciles from
// storage, no UI involved), then wait for the worker to mark it fired and to have asked for a notification.
await page.evaluate(async () => {
  const got = await chrome.storage.local.get('fogar.reminders');
  const list = got['fogar.reminders'] ?? [];
  list.push({ id: 'fire-test', label: 'fire test', when: Date.now() + 3000, createdAt: Date.now() });
  await chrome.storage.local.set({ 'fogar.reminders': list });
});
let fired = false; const tFire = Date.now();
while (Date.now() - tFire < 25000 && !fired) {
  fired = await page.evaluate(async () => ((await chrome.storage.local.get('fogar.reminders'))['fogar.reminders'] ?? []).some((r) => r.id === 'fire-test' && r.fired === true));
  if (!fired) await page.waitForTimeout(500);
}
const shown = await page.evaluate(() => chrome.notifications.getAll().catch(() => ({})));
check('reminder alarm fires and is marked done', fired, `${Date.now() - tFire} ms after scheduling; ${Object.keys(shown).length} notification(s) visible to the API`);

// 8. bookmarks
await page.evaluate(() => chrome.bookmarks.create({ title: 'Fogar Test Bookmark', url: 'https://example.com/fogar' }));
await page.fill('#prompt', 'Fogar Test');
await page.waitForSelector('#bookmark-hits:not([hidden]) .hit', { timeout: 5000 }).catch(() => {});
const hit = await page.evaluate(() => document.querySelector('#bookmark-hits .hit .t')?.textContent ?? '');
check('bookmark search as you type', hit === 'Fogar Test Bookmark', hit || 'no hit rendered');

// 8a. ranked search: typo in the query, folder name as the query, and a very long title stays inside the box
await page.evaluate(async () => {
  const folder = await chrome.bookmarks.create({ title: 'Reading List' });
  await chrome.bookmarks.create({ parentId: folder.id, title: 'A very long bookmark title that goes on and on describing an article about the history of typography in browser user interfaces and never seems to stop at all', url: 'https://example.net/long-article-about-typography' });
});
await page.fill('#prompt', 'fogr bookmrk');
await page.waitForSelector('#bookmark-hits:not([hidden]) .hit', { timeout: 5000 }).catch(() => {});
const typoHit = await page.evaluate(() => document.querySelector('#bookmark-hits .hit .t')?.textContent ?? '');
await page.fill('#prompt', 'reading list');
await page.waitForFunction(() => document.querySelector('#bookmark-hits .hit .h')?.textContent?.includes('Reading List'), null, { timeout: 5000 }).catch(() => {});
const folderRow = await page.evaluate(() => {
  const hit = document.querySelector('#bookmark-hits .hit');
  const box = document.getElementById('bookmark-hits');
  return { h: hit?.querySelector('.h')?.textContent ?? '', overflow: hit ? hit.scrollWidth > box.clientWidth + 1 : true, boxOverflow: box ? box.scrollWidth > box.clientWidth + 1 : true };
});
check('bookmark search: typo tolerance, folder path shown, long title contained', typoHit === 'Fogar Test Bookmark' && folderRow.h.includes('Reading List') && !folderRow.overflow && !folderRow.boxOverflow, `typo→"${typoHit}"; folder row "${folderRow.h.slice(0, 40)}"; overflow=${folderRow.overflow}`);

// 8b. natural-language bookmark finder (model picks 1 and 3 via the mock; keyword pass catches "Job posting")
await page.evaluate(async () => {
  await chrome.bookmarks.create({ title: 'Senior Engineer at Acme', url: 'https://acme.example/careers/123' });
  await chrome.bookmarks.create({ title: 'Recipe blog', url: 'https://food.example/' });
  await chrome.bookmarks.create({ title: 'Job posting: Data Analyst', url: 'https://jobs.example/456' });
});
await page.goto(`${base}?e2e=1&cloud=${mock.port}`);
await page.fill('#prompt', 'find and list bookmarks that are job postings');
await page.press('#prompt', 'Enter');
await waitDone(30000);
const finderLabel = await text('answer-label');
const finderHits = await page.evaluate(() => [...document.querySelectorAll('#answer-links .hit .t')].map((n) => n.textContent));
const finderOverflow = await page.evaluate(() => { const l = document.getElementById('answer-links'); const card = l?.closest('.answer-card'); return l && card ? l.scrollWidth > card.clientWidth : false; });
check('bookmark question routes to the finder and returns links', finderLabel === 'Bookmarks' && finderHits.includes('Job posting: Data Analyst') && finderHits.length >= 3 && !finderOverflow, `${finderHits.length} hits: ${finderHits.join(' | ').slice(0, 120)}; overflow=${finderOverflow}`);

// 10. widgets: add Links from the menu, add a site, persists
await page.goto(`${base}?e2e=1`);
await page.click('#widget-add');
await page.click('#widget-menu .menu-item:has-text("Links")');
await page.waitForSelector('.widget[data-type="links"] .add-link input');
await page.fill('.widget[data-type="links"] .add-link input:first-of-type', 'example.com');
await page.press('.widget[data-type="links"] .add-link input:first-of-type', 'Enter');
await page.waitForSelector('.widget[data-type="links"] .tile');
await page.reload();
await page.waitForSelector('.widget[data-type="links"] .tile');
const tileText = await page.evaluate(() => document.querySelector('.widget[data-type="links"] .tile .t')?.textContent);
check('links widget: add from menu, add a site, persists', tileText === 'example.com', `${tileText}`);

// 10b. notes widget saves as you type
await page.click('#widget-add');
await page.click('#widget-menu .menu-item:has-text("Notes")');
await page.waitForSelector('.widget[data-type="notes"] textarea');
await page.fill('.widget[data-type="notes"] textarea', 'ship it');
await page.waitForTimeout(700);
await page.reload();
await page.waitForSelector('.widget[data-type="notes"] textarea');
const noteText = await page.evaluate(() => document.querySelector('.widget[data-type="notes"] textarea')?.value);
check('notes widget persists', noteText === 'ship it', `${noteText}`);

// 10c. agenda from an iCal feed (recurring standup expands, cancelled event hidden, all-day tomorrow)
await page.evaluate(async (port) => {
  const got = await chrome.storage.local.get('fogar.layout');
  const layout = got['fogar.layout'];
  layout.widgets.push({ id: 'agenda-test', type: 'agenda', config: { url: `http://127.0.0.1:${port}/agenda.ics` } });
  layout.widgets.push({ id: 'weather-test', type: 'weather', config: { place: { name: 'Testville', region: '', country: '', lat: 1, lon: 2 }, unit: 'f', endpoint: `http://127.0.0.1:${port}/weather` } });
  layout.widgets.push({ id: 'recipe-test', type: 'recipe', config: { recipeId: 'rewrite', recipeName: 'Draft & rewrite' } });
  await chrome.storage.local.set({ 'fogar.layout': layout });
}, mock.port);
await page.reload();
await page.waitForSelector('.widget[data-type="agenda"] .event');
const agendaText = await page.evaluate(() => document.querySelector('.widget[data-type="agenda"] .agenda')?.textContent ?? '');
check('agenda widget renders today and tomorrow from iCal', agendaText.includes('Design review') && agendaText.includes('Standup') && agendaText.includes('Dentist') && !agendaText.includes('Cancelled thing') && agendaText.includes('All day'), agendaText.slice(0, 140));

// 10d. weather and pinned recipe widgets render
await page.waitForSelector('.widget[data-type="weather"] .temp');
const temp = await page.evaluate(() => document.querySelector('.widget[data-type="weather"] .temp')?.textContent);
const recipeForm = await page.evaluate(() => document.querySelector('.widget[data-type="recipe"] textarea') !== null);
const weatherTitle = await page.evaluate(() => document.querySelector('.widget[data-type="weather"] h2')?.textContent);
check('weather and pinned recipe widgets render', temp === '71°' && recipeForm && weatherTitle === 'Weather · Testville', `${temp}, ${weatherTitle}`);

// 10e. reorder, remove, focus
const firstBefore = await page.evaluate(() => document.querySelector('#widgets .widget')?.dataset.type);
await page.hover('#widgets .widget');
await page.click('#widgets .widget .ctl[title="Move down"]');
const firstAfter = await page.evaluate(() => document.querySelector('#widgets .widget')?.dataset.type);
await page.hover('.widget[data-type="notes"]');
await page.click('.widget[data-type="notes"] .ctl[title="Remove from page"]');
const notesGone = await page.evaluate(() => document.querySelector('.widget[data-type="notes"]') === null);
await page.click('#focus-toggle');
const cornerHidden = await page.evaluate(() => getComputedStyle(document.getElementById('corner')).display === 'none' && getComputedStyle(document.querySelector('.recipes')).display === 'none');
await page.reload();
await page.waitForSelector('#focus-toggle');
const focusPersists = await page.evaluate(() => document.documentElement.classList.contains('focus') && document.getElementById('focus-toggle').textContent === 'Show everything');
await page.click('#focus-toggle');
const cornerBack = await page.evaluate(() => getComputedStyle(document.getElementById('corner')).display !== 'none');
check('widgets reorder, remove, and focus mode persists', firstBefore !== firstAfter && notesGone && cornerHidden && focusPersists && cornerBack, `${firstBefore}→${firstAfter}`);

// 8c. the finder finds "cooking" bookmarks that never say "cook", via expanded terms; words-first ordering
await page.evaluate(() => chrome.bookmarks.create({ title: 'Risotto for beginners', url: 'https://food.example/risotto' }));
await page.goto(`${base}?e2e=1&cloud=${mock.port}`);
await page.fill('#prompt', 'find bookmarks about cooking');
await page.press('#prompt', 'Enter');
await waitDone(30000);
const cooking = await page.evaluate(() => [...document.querySelectorAll('#answer-links .hit .t')].map((n) => n.textContent));
const looked = await text('answer');
check('finder: "cooking" finds recipe and risotto bookmarks first, shows the terms it looked for', cooking[0] !== 'Fogar Test Bookmark' && cooking.includes('Recipe blog') && cooking.includes('Risotto for beginners') && /Looked for:.*risotto/.test(looked), `${cooking.join(' | ').slice(0, 100)}`);

// 8d. import forgives what people actually paste: raw line breaks inside strings, no labels, smart quotes
await page.goto(`${base}?e2e=1`);
await page.click('#recipe-import');
await page.fill('#recipe-panel textarea', '{\n  “name”: “Draft & rewrite Test”,\n  "inputs": [\n    { "key": "text",   "type": "textarea" },\n    { "key": "tone",   "type": "select", "options": ["Neutral","Friendly"] },\n  ],\n  "template": "Rewrite the text below.\n    Tone: {{tone}}. Extra: {{extra}}.\n\n    {{text}}"\n}');
await page.click('#recipe-panel .primary');
await page.waitForFunction(() => [...document.querySelectorAll('#recipe-chips .chip')].some((c) => c.textContent?.includes('Draft & rewrite Test')), null, { timeout: 5000 });
const importedLabels = await page.evaluate(() => [...document.querySelectorAll('#recipe-panel .field')].map((f) => f.firstChild?.textContent?.trim()));
await page.click('#recipe-import');
await page.fill('#recipe-panel textarea', '{ "name": "Broken" ');
await page.click('#recipe-panel .primary');
const importError = await text('toast');
check('recipe import forgives pasted JSON and explains failures', importedLabels.includes('Text') && importedLabels.includes('Tone') && importedLabels.includes('Extra') && /not valid JSON/.test(importError), `labels ${importedLabels.join(', ')}; error "${importError.slice(0, 60)}"`);

// 11. right-click "Ask Fogar about …" carries the page: title, address, excerpt; quotes not doubled
await page.goto(`${base}?e2e=1&cloud=${mock.port}`); // saves cloud settings so the new tab is ready to answer
const webPage = await context.newPage();
await webPage.goto(`http://127.0.0.1:${mock.port}/page.html`);
const newTabPromise = context.waitForEvent('page', { timeout: 15000 });
const clickRes = await page.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const target = tabs.find((t) => (t.url || '').includes('/page.html'));
  return chrome.runtime.sendMessage({ type: 'test.contextClick', tabId: target?.id, selectionText: '"The Micro Startups Guy"' });
});
const newTab = await newTabPromise;
await newTab.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: 30000 });
const ctxQ = await newTab.evaluate(() => document.querySelector('#answer-card .answer-q')?.childNodes[0]?.textContent ?? '');
const ctxChip = await newTab.evaluate(() => document.querySelector('#answer-card .ctx-chip')?.textContent ?? '');
const ctxSys = (mock.server.lastRequest?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
check('right-click question carries page title, address, and excerpt; quotes not doubled',
  clickRes?.ok === true && ctxQ.trim() === 'Explain this: “The Micro Startups Guy”' && ctxChip.startsWith('from 127.0.0.1') && ctxSys.includes('Acme Careers: Senior Engineer') && ctxSys.includes('newsletter of the same name') && ctxSys.includes('/page.html'),
  `click=${JSON.stringify(clickRes)} q="${ctxQ.trim()}" chip="${ctxChip}" title=${ctxSys.includes('Acme Careers')} url=${ctxSys.includes('/page.html')} excerpt=${ctxSys.includes('newsletter of the same name')}`);
await newTab.close(); await webPage.close();

// 12. Sessions widget: a second window with two real tabs is saved and closed, searchable, bookmarkable, restorable
try {
await page.goto(`${base}?e2e=1`);
await page.waitForSelector('#recipe-chips .chip');
const winBefore = await page.evaluate(() => chrome.windows.getAll().then((w) => w.length));
const newWinId = await page.evaluate(async (port) => { const w = await chrome.windows.create({ url: [`http://127.0.0.1:${port}/page.html`, `http://127.0.0.1:${port}/invoice.html`, `http://127.0.0.1:${port}/invoice.html`], focused: false }); return w.id; }, mock.port);
await page.waitForFunction(async () => { const titles = (await chrome.tabs.query({ url: 'http://127.0.0.1/*' })).map((t) => t.title ?? ''); return titles.some((t) => t.startsWith('Acme Careers')) && titles.filter((t) => t.startsWith('Quarterly Invoice')).length === 2; }, null, { timeout: 20000 });
await page.click('#widget-add');
await page.click('#widget-menu .menu-item:has-text("Sessions")');
await page.waitForSelector('.widget[data-type="sessions"] .sess-win:has-text("Window")', { timeout: 10000 });
const openText = await page.evaluate(() => document.querySelector('.widget[data-type="sessions"] .sess-head span')?.textContent ?? '');
// 12pre. the widget spans the row, nothing overflows the card, and clicking a window row brings that window to the front
const wideState = await page.evaluate(() => { const card = document.querySelector('.widget[data-type="sessions"]'); return { wide: card.classList.contains('wide'), overflow: card.scrollWidth > card.clientWidth + 1, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; });
await page.click('.widget[data-type="sessions"] .sess-win:has-text("Acme Careers") .t');
await page.waitForTimeout(400);
const focusedId = await page.evaluate(() => chrome.windows.getLastFocused().then((w) => w.id));
check('sessions: full width by default, no overflow, clicking a window focuses it', wideState.wide && !wideState.overflow && !wideState.pageOverflow && focusedId === newWinId, `${JSON.stringify(wideState)} focused=${focusedId === newWinId}`);
// 12a. the same box finds tabs that are open right now, and a hit switches to that tab
await page.evaluate(async () => { const cur = await chrome.windows.getCurrent(); await chrome.windows.update(cur.id, { focused: true }); });
await page.fill('.widget[data-type="sessions"] input[type="search"]', 'invoice');
await page.waitForSelector('.widget[data-type="sessions"] .sess-tab.live', { timeout: 5000 });
const liveRow = await page.evaluate(() => { const r = document.querySelector('.widget[data-type="sessions"] .sess-tab.live'); return { title: r?.querySelector('button.t')?.textContent ?? '', tag: r?.querySelector('.tag')?.textContent ?? '' }; });
await page.click('.widget[data-type="sessions"] .sess-tab.live button.t');
await page.waitForTimeout(400);
const switched = await page.evaluate(async () => { const w = await chrome.windows.getLastFocused(); const [t] = await chrome.tabs.query({ active: true, windowId: w.id }); return { windowId: w.id, url: t?.url ?? '' }; });
await page.fill('.widget[data-type="sessions"] input[type="search"]', '');
check('sessions: open tabs are searchable and a hit switches to the tab',
  liveRow.title.startsWith('Quarterly Invoice') && liveRow.tag === 'open' && switched.windowId === newWinId && /invoice\.html$/.test(switched.url),
  `${JSON.stringify(liveRow)} ${JSON.stringify(switched)}`);

await page.click('.widget[data-type="sessions"] .sess-win:has-text("Acme Careers") button:has-text("Save & close")');
await page.waitForFunction((n) => chrome.windows.getAll().then((w) => w.length === n), winBefore, { timeout: 10000 });
await page.waitForSelector('.widget[data-type="sessions"] .sess-session');
const sessText = await page.evaluate(() => document.querySelector('.widget[data-type="sessions"] .sess-session')?.textContent ?? '');
const toastText = await text('toast');
check('sessions: save & close a window; duplicates dropped; window gone', /2 windows · 3 tabs open/.test(openText) && /2 tabs/.test(sessText) && /1 duplicate dropped/.test(toastText), `open="${openText}" session="${sessText.slice(0, 60)}"`);

// 12b. search from the ask bar and inside the widget; bookmark all; remove one
await page.fill('#prompt', 'quarterly invoice');
await page.waitForSelector('#bookmark-hits:not([hidden]) .hit.saved', { timeout: 5000 }).catch(() => {});
const askHit = await page.evaluate(() => document.querySelector('#bookmark-hits .hit.saved .t')?.textContent ?? '');
await page.fill('#prompt', '');
await page.fill('.widget[data-type="sessions"] input[type="search"]', 'acme');
await page.waitForSelector('.widget[data-type="sessions"] .sess-saved .sess-tab');
const widgetHit = await page.evaluate(() => document.querySelector('.widget[data-type="sessions"] .sess-saved .sess-tab a')?.textContent ?? '');
await page.fill('.widget[data-type="sessions"] input[type="search"]', '');
await page.waitForSelector('.widget[data-type="sessions"] .sess-session');
await page.click('.widget[data-type="sessions"] .sess-session button:has-text("Bookmark all")');
await page.waitForFunction(() => chrome.bookmarks.search({ title: 'Quarterly Invoice from Globex' }).then((r) => r.length >= 1), null, { timeout: 5000 });
const folderOk = await page.evaluate(async () => { const hits = await chrome.bookmarks.search({ title: 'Quarterly Invoice from Globex' }); const parent = (await chrome.bookmarks.get(hits[0].parentId))[0]; return !parent.url && /127\.0\.0\.1/.test(parent.title); });
await page.click('.widget[data-type="sessions"] .sess-name');
await page.waitForSelector('.widget[data-type="sessions"] .sess-tabs .sess-tab');
// "Bookmark all" just kept every tab, so each row's bookmark should be drawn filled and stay visible unhovered.
const kept = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.widget[data-type="sessions"] .sess-tabs .sess-tab')];
  return { rows: rows.length, filled: rows.filter((r) => r.querySelector('.bm.on svg path[fill="currentColor"]')).length, visible: rows.every((r) => getComputedStyle(r.querySelector('.bm')).opacity === '1') };
});
await page.hover('.widget[data-type="sessions"] .sess-tabs .sess-tab:has-text("Acme")');
await page.click('.widget[data-type="sessions"] .sess-tabs .sess-tab:has-text("Acme") .x');
await page.waitForFunction(() => document.querySelectorAll('.widget[data-type="sessions"] .sess-tabs .sess-tab').length === 1, null, { timeout: 5000 });
check('sessions: ask-bar and widget search, bookmark all into a session folder, remove a tab', askHit === 'Quarterly Invoice from Globex' && widgetHit.includes('Acme Careers') && folderOk, `ask="${askHit}" widget="${widgetHit.slice(0, 30)}" folder=${folderOk}`);
check('sessions: a bookmarked tab shows a filled bookmark without hovering', kept.rows > 0 && kept.filled === kept.rows && kept.visible, JSON.stringify(kept));

// 12b2. export: the Markdown list and the browser bookmarks file both carry the remaining link
await page.click('.widget[data-type="sessions"] .sess-session .sess-export .ctl');
const [mdDl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('.widget[data-type="sessions"] .sess-session .sess-export-menu .menu-item:has-text("Markdown list")')]);
const mdText = readFileSync(await mdDl.path(), 'utf8');
await page.click('.widget[data-type="sessions"] .sess-session .sess-export .ctl');
const [htmlDl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('.widget[data-type="sessions"] .sess-session .sess-export-menu .menu-item:has-text("Browser bookmarks")')]);
const htmlText = readFileSync(await htmlDl.path(), 'utf8');
await page.click('.widget[data-type="sessions"] .sess-saved-head .sess-export .ctl');
const [jsonDl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('.widget[data-type="sessions"] .sess-saved-head .sess-export-menu .menu-item:has-text("Fogar file")')]);
const fogarFile = JSON.parse(readFileSync(await jsonDl.path(), 'utf8'));
check('sessions: export as Markdown, browser bookmarks file, and Fogar file',
  mdDl.suggestedFilename().endsWith('.md') && /\[Quarterly Invoice from Globex\]\(http:\/\/127\.0\.0\.1:\d+\/invoice\.html\)/.test(mdText)
    && htmlText.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>') && /<DT><A HREF="http:\/\/127\.0\.0\.1:\d+\/invoice\.html"/.test(htmlText) && /<H3[^>]*>Sep|<H3[^>]*>\w/.test(htmlText)
    && fogarFile.fogar === 1 && Array.isArray(fogarFile.sessions) && fogarFile.sessions.length === 1 && jsonDl.suggestedFilename().startsWith('fogar-sessions-'),
  `${mdDl.suggestedFilename()}, ${htmlDl.suggestedFilename()}, ${jsonDl.suggestedFilename()}`);

// 12c. restore reopens the window; delete removes the session
await page.click('.widget[data-type="sessions"] .sess-session button:has-text("Restore")');
await page.waitForFunction((n) => chrome.windows.getAll().then((w) => w.length === n + 1), winBefore, { timeout: 10000 });
const restoredUrls = await page.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1/*' })).map((t) => t.url));
// The restored tab is now both open and saved. It should be listed once, as the open one you can switch to.
await page.fill('.widget[data-type="sessions"] input[type="search"]', 'invoice');
await page.waitForSelector('.widget[data-type="sessions"] .sess-tab.live', { timeout: 5000 });
const dedupe = await page.evaluate(async () => {
  const open = new Set((await chrome.tabs.query({ url: 'http://127.0.0.1/*' })).map((t) => t.url));
  const rows = [...document.querySelectorAll('.widget[data-type="sessions"] .sess-saved .sess-tab')];
  return { live: rows.filter((r) => r.classList.contains('live')).length, savedAlsoOpen: rows.filter((r) => !r.classList.contains('live')).filter((r) => open.has(r.querySelector('a')?.href)).length };
});
await page.fill('.widget[data-type="sessions"] input[type="search"]', '');
check('sessions: a tab that is open and saved is listed once, as the open one', dedupe.live > 0 && dedupe.savedAlsoOpen === 0, JSON.stringify(dedupe));
await page.evaluate(async () => { const ws = await chrome.windows.getAll({ populate: true }); const cur = await chrome.windows.getCurrent(); for (const w of ws) if (w.id !== cur.id) await chrome.windows.remove(w.id); });
page.once('dialog', (d) => { d.accept().catch(() => {}); }); // the delete confirm; a second handler must never race this one
await page.click('.widget[data-type="sessions"] .sess-session .ctl[title="Delete this saved session"]');
await page.waitForFunction(() => document.querySelector('.widget[data-type="sessions"] .sess-session') === null, null, { timeout: 5000 });
check('sessions: restore reopens the saved window; delete removes the session', restoredUrls.length === 1 && /invoice\.html/.test(restoredUrls[0]), `restored: ${restoredUrls.join(', ')}`);
} catch (err) {
  check('sessions: flow completed without a thrown step', false, String(err.message ?? err).split('\n')[0].slice(0, 160));
  await page.evaluate(async () => { const ws = await chrome.windows.getAll(); const cur = await chrome.windows.getCurrent(); for (const w of ws) if (w.id !== cur.id) await chrome.windows.remove(w.id).catch(() => {}); }).catch(() => {});
}

// 13. Customize: appearance, accent, paper, headings, density apply, persist, and the boot script restores them first
await page.goto(`${base}?e2e=1`);
await page.waitForSelector('#customize-btn');
// The default is serif headings. Asserting only the flipped state let a self-referential --heading ship, which
// fell back to the body sans and made both settings look identical.
const defaultBrandFont = await page.evaluate(() => getComputedStyle(document.querySelector('.brand')).fontFamily.slice(0, 8));
check('customize: headings are serif out of the box', defaultBrandFont === 'ui-serif', defaultBrandFont);
await page.click('#customize-btn');
await page.click('#customize-menu [data-appearance="dark"]');
await page.click('#customize-menu [data-accent="Moss"]');
await page.click('#customize-menu [data-paper="cool"]');
await page.click('#customize-menu [data-headings="sans"]');
await page.click('#customize-menu [data-density="compact"]');
const menuStillOpen = await page.evaluate(() => !document.getElementById('customize-menu').hidden);
const applied = await page.evaluate(() => { const r = document.documentElement; const cs = getComputedStyle(r); return { theme: r.dataset.theme, h: cs.getPropertyValue('--h').trim(), ph: cs.getPropertyValue('--ph').trim(), headings: r.dataset.headings, density: r.dataset.density, brandFont: getComputedStyle(document.querySelector('.brand')).fontFamily.slice(0, 13) }; });
await page.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { const r = document.documentElement; window.__boot = { theme: r.dataset.theme, h: r.style.getPropertyValue('--h'), density: r.dataset.density }; }); });
await page.reload();
await page.waitForSelector('#customize-btn');
const boot = await page.evaluate(() => window.__boot);
check('customize: theme applies, persists, and the boot script restores it before first paint', menuStillOpen && applied.theme === 'dark' && applied.h === '145' && applied.ph === '250' && applied.headings === 'sans' && applied.density === 'compact' && applied.brandFont === 'ui-sans-serif' && boot?.theme === 'dark' && boot?.h === '145' && boot?.density === 'compact', JSON.stringify({ applied, boot }));

// 14. Customize: layout — centered ask box, sidebar on a wide window, hidden recipes, 3 columns; persists
await page.setViewportSize({ width: 1440, height: 900 });
await page.click('#customize-btn');
await page.click('#customize-menu [data-ask="centered"]');
await page.click('#customize-menu [data-arrangement="sidebar"]');
await page.click('#customize-menu [data-recipes="hidden"]');
const lay1 = await page.evaluate(() => ({ ask: document.documentElement.dataset.ask, pageCols: getComputedStyle(document.querySelector('.page')).gridTemplateColumns.trim().split(/\s+/).length, recipes: getComputedStyle(document.querySelector('.recipes')).display, askMin: Math.round(parseFloat(getComputedStyle(document.querySelector('.ask')).minHeight)) }));
await page.click('#customize-menu [data-arrangement="stack"]');
await page.click('#customize-menu [data-columns="3"]');
const lay2 = await page.evaluate(() => ({ panelCols: getComputedStyle(document.getElementById('widgets')).gridTemplateColumns.trim().split(/\s+/).length, pageCols: getComputedStyle(document.querySelector('.page')).gridTemplateColumns.trim().split(/\s+/).length }));
await page.reload(); await page.waitForSelector('#customize-btn');
const lay3 = await page.evaluate(() => ({ ask: document.documentElement.dataset.ask, columns: document.documentElement.dataset.columns, recipes: document.documentElement.dataset.recipes, mirrored: JSON.parse(localStorage.getItem('fogar.layout') || '{}').columns }));
check('customize: layout options apply and persist', lay1.ask === 'centered' && lay1.pageCols === 2 && lay1.recipes === 'none' && lay1.askMin > 300 && lay2.panelCols === 3 && lay2.pageCols === 1 && lay3.ask === 'centered' && lay3.columns === '3' && lay3.recipes === 'hidden' && lay3.mirrored === 3, JSON.stringify({ lay1, lay2, lay3 }));
await page.setViewportSize({ width: 1280, height: 800 });
await page.click('#customize-btn'); await page.click('#customize-menu [data-reset="all"]');
await page.waitForFunction(() => document.documentElement.dataset.ask === 'top' && !document.documentElement.dataset.theme && getComputedStyle(document.documentElement).getPropertyValue('--h').trim() === '40', null, { timeout: 5000 }).catch(() => {});
const resetState = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme ?? null, h: getComputedStyle(document.documentElement).getPropertyValue('--h').trim(), ask: document.documentElement.dataset.ask, columns: document.documentElement.dataset.columns, recipes: document.documentElement.dataset.recipes }));
check('customize: reset returns theme and layout to the defaults, widgets untouched', resetState.theme === null && resetState.h === '40' && resetState.ask === 'top' && resetState.columns === 'auto' && resetState.recipes === 'shown' && (await page.evaluate(() => document.querySelectorAll('#widgets .widget').length)) > 0, JSON.stringify(resetState));

// 15. drag a widget by its title to reorder; the order persists
await page.evaluate(() => chrome.storage.local.set({ 'fogar.layout': { version: 1, widgets: [{ id: 'todos', type: 'todos', config: {} }, { id: 'reminders', type: 'reminders', config: {} }], focus: false, ask: 'top', arrangement: 'stack', columns: 'auto', showRecipes: true } }));
await page.goto(`${base}?e2e=1`); await page.waitForSelector('#widgets .widget');
const orderBefore = await page.evaluate(() => [...document.querySelectorAll('#widgets .widget')].map((w) => w.dataset.type));
await page.locator('#widgets .widget').first().locator('h2').dragTo(page.locator('#widgets .widget').nth(1), { targetPosition: { x: 260, y: 20 } });
await page.waitForFunction((b) => document.querySelectorAll('#widgets .widget')[0]?.dataset.type !== b[0], orderBefore, { timeout: 5000 }).catch(() => {});
const orderAfter = await page.evaluate(() => [...document.querySelectorAll('#widgets .widget')].map((w) => w.dataset.type));
await page.reload(); await page.waitForSelector('#widgets .widget');
const orderReload = await page.evaluate(() => [...document.querySelectorAll('#widgets .widget')].map((w) => w.dataset.type));
check('drag a widget title to reorder; the order persists', orderBefore.length === 2 && orderAfter[0] === orderBefore[1] && orderAfter[1] === orderBefore[0] && orderReload.join() === orderAfter.join(), `${orderBefore.join('→')} ⇒ ${orderAfter.join('→')}`);

// 16. a theme link applies and is saved
const encTheme = await page.evaluate(() => btoa(JSON.stringify({ version: 1, appearance: 'light', hue: 325, chroma: 0.14, accentName: 'Plum', paper: 'neutral', headings: 'serif', density: 'comfortable' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
await page.goto(`${base}?e2e=1&theme=${encTheme}`); await page.waitForSelector('#customize-btn');
const linked = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, h: getComputedStyle(document.documentElement).getPropertyValue('--h').trim(), ph: getComputedStyle(document.documentElement).getPropertyValue('--ph').trim() }));
await page.goto(`${base}?e2e=1`); await page.waitForSelector('#customize-btn');
const linkedPersist = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--h').trim());
check('a theme link applies and is saved', linked.theme === 'light' && linked.h === '325' && linked.ph === '0' && linkedPersist === '325', JSON.stringify(linked));
await page.click('#customize-btn'); await page.click('#customize-menu [data-reset="all"]');
await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--h').trim() === '40', null, { timeout: 5000 }).catch(() => {});

// 9. share link offers the recipe
const shared = await page.evaluate(() => btoa(JSON.stringify({ version: 1, id: 'shared-test', name: 'Shared Test', description: 'd', inputs: [{ key: 'text', label: 'Text', type: 'textarea' }], template: 'Do {{text}}' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
await page.goto(`${base}?e2e=1&recipe=${shared}`);
await page.waitForSelector('#recipe-panel:not([hidden])');
const offer = await text('recipe-panel');
await page.click('#recipe-panel .primary');
await page.waitForFunction(() => [...document.querySelectorAll('#recipe-chips .chip')].some((c) => c.textContent?.includes('Shared Test')));
check('shared recipe link offers and adds the recipe', offer.includes('Add “') && offer.includes('Shared Test'));

mock.server.close();
await context.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
const interesting = logs.filter((l) => process.env.VERBOSE === '1' || /pageerror|\[error\]|refused|csp|blocked|fogar\]/i.test(l)).slice(-30);
if (interesting.length) console.log('console:\n  ' + interesting.join('\n  '));
process.exit(failed.length ? 1 : 0);

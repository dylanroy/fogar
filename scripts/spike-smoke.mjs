// End-to-end test. Loads the built extension into Chromium and drives every feature:
//   1. local model: download, load, stream (1 MB test model by default; MODEL=qwen3-0.6b for the real one)
//   2. warm reload served from OPFS with zero GGUF downloads
//   3. cloud mode against a local mock OpenAI server (SSE parser, bearer header)
//   4. web grounding against a mock Brave endpoint (snippets reach the model, sources render, citation shows)
//   5. built-in recipe run (template filled, system prompt applied)
//   6. todos persist across reload
//   7. reminders parse, confirm, save, and create a chrome.alarms entry
//   8. bookmark search as you type
// Usage: npm run build && npm run test:spike   (HEADED=1 to watch, GPU=1 for WebGPU, VERBOSE=1 for all console lines)
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockServer } from './mock-openai.mjs';

const ext = resolve('.output/chrome-mv3');
const userDataDir = mkdtempSync(join(tmpdir(), 'fogar-smoke-'));
const headless = process.env.HEADED !== '1';
const gpu = process.env.GPU === '1' ? '1' : '0';
const model = process.env.MODEL || 'smoke';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium', headless,
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
const focusPersists = await page.evaluate(() => document.body.classList.contains('focus') && document.getElementById('focus-toggle').textContent === 'Show everything');
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

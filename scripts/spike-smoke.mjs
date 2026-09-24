// End-to-end test. Loads the built extension into Chromium and drives every feature:
//   1. local model: download, load, stream (1 MB test model by default; MODEL=qwen3-0.6b for the real one)
//   2. warm reload served from OPFS with zero GGUF downloads
//   3. cloud mode against a local mock OpenAI server (SSE parser, bearer header)
//   4. web grounding against a mock Brave endpoint (snippets reach the model, sources render, citation shows)
//   5. built-in recipe run (template filled, system prompt applied)
//   6. todos persist across reload
//   7. reminders parse, confirm, save, and create a chrome.alarms entry
//   8. bookmark search as you type
//   9. widgets: inbox (Gmail feed and API), feed (RSS, Atom, a site that advertises its feed, a search), Jira,
//      LLM chat (OpenAI-compatible and Anthropic profiles, history, persistence), post-its (drag, pull off into a
//      widget), canvas (draw, text, undo, the model draws, PNG), notebook (pages, a photo read by a model), full screen
//  10. writing: samples typed and dropped, a voice distilled by the model, a register with rules, a run whose prompt
//      carries profile and rules and whose output has the banned em dash removed, everything persisting
// Usage: npm run test:spike   (HEADED=1 to watch, GPU=1 for WebGPU, VERBOSE=1 for all console lines)
// The suite builds its own test variant (WXT_E2E=1 → .output-e2e) with a host permission for the mock server, so
// the right-click page-context path can run for real. The store build in .output is untouched.
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startMockServer } from './mock-openai.mjs';
import { strToU8, zipSync } from 'fflate';

// A small PDF with real text objects, one page per entry, so pdf.js has something to extract.
function makePdf(pages) {
  const esc = (s) => s.replace(/[()\\]/g, '\\$&');
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; }; // returns the object number
  const catalog = add(''); const pagesObj = add(''); const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const lines of pages) {
    const content = `BT /F1 12 Tf 50 740 Td 16 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
    const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${stream} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
// The smallest .docx Word would recognise: a zip with the content types, the package relationship, and the document part.
function makeDocx(paragraphs) {
  const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xml(p)}</w:t></w:r></w:p>`).join('');
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
  }));
}

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
check('keyless grounding: DuckDuckGo + Wikipedia, no key, deduped, attributed, body-text noise and stubs dropped',
  (await status()) === 'done' && freeUser.includes('MOCK DDG ABSTRACT') && freeUser.includes('MOCK WIKI EXTRACT') && !freeUser.includes('MOCK WIKI SECOND') && !freeUser.includes('Category')
    && !freeUser.includes('MOCK WIKI NOISE') && !freeUser.includes('may refer to')
    && freeSources.length === 4 && /DuckDuckGo · Wikipedia/.test(freeSources[0]) && /Wikipedia$/.test(freeSources[1]) && mock.server.lastFree?.ddgQ === 'the US president' && mock.server.lastFree?.wikiQ === 'the US president',
  `${freeSources.length} sources; q="${mock.server.lastFree?.wikiQ}"; first="${freeSources[0]?.slice(0, 50)}"`);

// 3f2. results the answer never cites stay off the card; the stats line and the Dig deeper menu say they were fetched
await page.goto(`${base}?e2e=1&cloud=${mock.port}&ground=${mock.port}`);
await page.fill('#prompt', 'markdown test'); // the mock answers this one without a citation
await page.press('#prompt', 'Enter');
await waitDone(30000);
const uncited = await page.evaluate(() => ({ hidden: document.getElementById('sources').hidden, items: document.querySelectorAll('#sources li').length, stats: document.getElementById('stats').textContent ?? '' }));
await page.click('#answer-card .dig-btn');
const uncitedNote = await page.evaluate(() => document.querySelector('#answer-card .dig-menu .menu-item:disabled .muted')?.textContent ?? '');
check('grounding: results the answer never cites stay off the card, and the stats line says so',
  uncited.hidden && uncited.items === 0 && /2 web results, none cited/.test(uncited.stats) && mock.server.lastSearch?.q === 'markdown test' && /already fetched/.test(uncitedNote),
  `stats="${uncited.stats}"; note="${uncitedNote}"`);

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
await page.click('#widget-menu .menu-item[data-widget="links"]');
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
await page.click('#widget-menu .menu-item[data-widget="notes"]');
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
// The new tab can be caught before it has a body; a throwing predicate would end the whole run.
await newTab.waitForFunction(() => document.body?.dataset.status === 'done', null, { timeout: 30000 });
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
await page.click('#widget-menu .menu-item[data-widget="sessions"]');
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
// The box is above the window list, the list folds away while filtering, and the first hit lands right under
// the box rather than below however many windows are open.
const filterUi = await page.evaluate(() => {
  const w = document.querySelector('.widget[data-type="sessions"]');
  const box = w.querySelector('input[type="search"]'); const open = w.querySelector('.sess-open');
  const row = w.querySelector('.sess-saved .sess-tab');
  return { boxFirst: !!(box.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING), openHidden: open.hidden, gap: Math.round(row.getBoundingClientRect().top - box.getBoundingClientRect().bottom) };
});
await page.click('.widget[data-type="sessions"] .sess-tab.live button.t');
await page.waitForTimeout(400);
const switched = await page.evaluate(async () => { const w = await chrome.windows.getLastFocused(); const [t] = await chrome.tabs.query({ active: true, windowId: w.id }); return { windowId: w.id, url: t?.url ?? '' }; });
await page.fill('.widget[data-type="sessions"] input[type="search"]', '');
await page.waitForFunction(() => !document.querySelector('.widget[data-type="sessions"] .sess-open').hidden, null, { timeout: 5000 });
check('sessions: the search box sits above the window list and results land under it', filterUi.boxFirst && filterUi.openHidden && filterUi.gap >= 0 && filterUi.gap < 60, JSON.stringify(filterUi));
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

// 17. the first screen: a quoted example as the placeholder, four rotating chips plus help, controls inside the box
await page.goto(`${base}?e2e=1&cloud=${mock.port}`);
await page.waitForSelector('#examples .help-chip');
const firstScreen = await page.evaluate(() => ({ placeholder: document.getElementById('prompt').placeholder, chips: [...document.querySelectorAll('#examples .example')].map((b) => b.textContent), sendInside: !!document.querySelector('#askframe #ask-btn'), attachInside: !!document.querySelector('#askframe #attach-btn'), askBelow: !!document.querySelector('.ask-row #ask-btn') }));
check('first screen: quoted example placeholder, four chips plus help, send and attach inside the box', /^e\.g\. "/.test(firstScreen.placeholder) && firstScreen.chips.length === 5 && /What can I type here/.test(firstScreen.chips[4]) && firstScreen.sendInside && firstScreen.attachInside && !firstScreen.askBelow, JSON.stringify(firstScreen).slice(0, 200));
await page.click('#examples .help-chip');
await page.waitForSelector('#help-card:not([hidden])');
const helpText = await text('help-card');
await page.click('#help-card .help-head button');
const helpHidden = await page.evaluate(() => document.getElementById('help-card').hidden);
check('help card lists every route as a static card and closes', /remind me/.test(helpText) && /todo:/.test(helpText) && /dropped file/.test(helpText) && /Enter searches/.test(helpText) && helpHidden, helpText.slice(0, 90));

// 18. attachments: a text file goes in front of the model, stays for follow-ups, and leaves with the conversation
await page.setInputFiles('#attach-input', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Meeting notes. The irrigation invoice from Hollis & Vane is 4,850 dollars, due November 14.') });
await page.waitForSelector('#attachments .attachment:not(.busy)');
const chip1 = await page.evaluate(() => document.querySelector('#attachments .attachment')?.textContent ?? '');
const filePlaceholder = await page.evaluate(() => document.getElementById('prompt').placeholder);
await page.fill('#prompt', 'How much is the invoice?');
await page.press('#prompt', 'Enter');
await waitDone(30000);
const attSys = (mock.server.lastRequest?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
const attChip = await page.evaluate(() => document.querySelector('#answer-card .ctx-chip')?.textContent ?? '');
const stillAttached = await page.evaluate(() => document.querySelectorAll('#attachments .attachment').length);
check('a text file goes in front of the model, with a chip on the box and on the card', chip1.includes('notes.txt') && /\d+ words/.test(chip1) && /Ask about the file/.test(filePlaceholder) && attSys.includes('File "notes.txt"') && attSys.includes('4,850 dollars') && attChip === 'from notes.txt' && stillAttached === 1, `chip="${chip1}" card="${attChip}"`);
await page.fill('#prompt', 'And when is it due?');
await page.press('#prompt', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('#thread .answer-card').length === 2 && document.body.dataset.status === 'done', null, { timeout: 30000 });
const followSys = (mock.server.lastRequest?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
await page.click('#thread-clear');
const cleared = await page.evaluate(() => ({ chips: document.querySelectorAll('#attachments .attachment').length, examples: !document.getElementById('examples').hidden }));
check('the file stays for follow-ups and leaves with "New conversation"', followSys.includes('4,850 dollars') && cleared.chips === 0 && cleared.examples, `follow-up carried file=${followSys.includes('4,850')}; after clear ${JSON.stringify(cleared)}`);

// 18b. PDF pages and a Word file are read in the browser; the prompt says how many pages there were
await page.setInputFiles('#attach-input', [
  { name: 'lease.pdf', mimeType: 'application/pdf', buffer: makePdf([['Lease agreement for 12 Elm Street.', 'Monthly rent: 1,950 dollars, due on the first.'], ['Deposit: 3,900 dollars, returned within 21 days.']]) },
  { name: 'memo.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: makeDocx(['Memo to all staff.', 'The offsite moves to Friday the 17th; lunch is provided.']) },
]);
await page.waitForFunction(() => document.querySelectorAll('#attachments .attachment:not(.busy)').length === 2 && !document.querySelector('#attachments .busy'), null, { timeout: 30000 });
const chips2 = await page.evaluate(() => [...document.querySelectorAll('#attachments .attachment')].map((c) => c.textContent));
await page.fill('#prompt', 'What is the rent, and when is the offsite?');
await page.press('#prompt', 'Enter');
await waitDone(30000);
const sys2 = (mock.server.lastRequest?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
check('a PDF and a Word file are read in the browser, pages counted', chips2.some((c) => /lease\.pdf.*2 pages/.test(c)) && chips2.some((c) => /memo\.docx.*\d+ words/.test(c)) && sys2.includes('1,950 dollars') && sys2.includes('3,900 dollars') && sys2.includes('Friday the 17th') && /2 pages/.test(sys2), chips2.join(' | '));
await page.click('#attachments .attachment .x');
const afterRemove = await page.evaluate(() => document.querySelectorAll('#attachments .attachment').length);
check('a chip\'s × removes that file', afterRemove === 1, `${afterRemove} left`);

// 18c. a long file is cut to the budget and the chip says so; an image is declined with a reason
await page.setInputFiles('#attach-input', { name: 'long.txt', mimeType: 'text/plain', buffer: Buffer.from(Array.from({ length: 9000 }, (_, i) => `w${i}`).join(' ')) });
await page.waitForFunction(() => [...document.querySelectorAll('#attachments .attachment:not(.busy)')].some((c) => /long\.txt/.test(c.textContent)), null, { timeout: 10000 });
const longChip = await page.evaluate(() => [...document.querySelectorAll('#attachments .attachment:not(.busy)')].map((c) => c.textContent).find((t) => /long\.txt/.test(t)) ?? '');
await page.setInputFiles('#attach-input', { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
await page.waitForFunction(() => /reads text, not images/.test(document.getElementById('toast')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
const imgToast = await text('toast');
check('a long file is cut to what fits and says so; an image is declined with a reason', /read the first [\d,]+ of 9,000 words/.test(longChip) && /reads text, not images/.test(imgToast), `${longChip} | ${imgToast.slice(0, 50)}`);

// 18d. a recipe field fills itself from a dropped file
await page.goto(`${base}?e2e=1&cloud=${mock.port}`);
await page.click('#recipe-chips .chip:has-text("Summarize")');
await page.waitForSelector('#recipe-panel textarea');
const dt = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(['Dear team, the offsite moves to Friday. Lunch is provided.'], 'memo.txt', { type: 'text/plain' })); return d; });
await page.dispatchEvent('#recipe-panel textarea', 'drop', { dataTransfer: dt });
await page.waitForFunction(() => /offsite moves to Friday/.test(document.querySelector('#recipe-panel textarea')?.value ?? ''), null, { timeout: 10000 }).catch(() => {});
const recipeField = await page.evaluate(() => ({ value: document.querySelector('#recipe-panel textarea')?.value ?? '', placeholder: document.querySelector('#recipe-panel textarea')?.placeholder ?? '' }));
check('a recipe field fills itself from a dropped file', /offsite moves to Friday/.test(recipeField.value) && /drop a file/i.test(recipeField.placeholder), recipeField.placeholder.slice(0, 80));

// 18e. a question about a file skips the web search even with the toggle ticked; Dig deeper adds results on request,
// and then the prompt says to answer from the file first, with the conversation as it was built (here: empty)
await page.goto(`${base}?e2e=1&cloud=${mock.port}&ground=${mock.port}`);
await page.waitForSelector('#ground-toggle:not([hidden])');
const toggleFree = await page.evaluate(() => ({ checked: document.getElementById('ground').checked, disabled: document.getElementById('ground').disabled }));
await page.setInputFiles('#attach-input', { name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Quarterly brief. Revenue was 24.18 billion dollars; three hundred products were cut.') });
await page.waitForSelector('#attachments .attachment:not(.busy)');
const toggleWithFile = await page.evaluate(() => ({ disabled: document.getElementById('ground').disabled, title: document.getElementById('ground-toggle').title }));
mock.server.lastSearch = null;
await page.fill('#prompt', 'Give me some bullets from the document');
await page.press('#prompt', 'Enter');
await waitDone(30000);
const fileAsk = { searched: mock.server.lastSearch !== null, sources: await page.evaluate(() => document.querySelectorAll('#sources li').length), sys: (mock.server.lastRequest?.messages ?? []).find((m) => m.role === 'system')?.content ?? '', stats: await text('stats') };
await page.click('#answer-card .dig-btn');
const fileDigNote = await page.evaluate(() => [...document.querySelectorAll('#answer-card .dig-menu .menu-item')].find((b) => b.querySelector('strong')?.textContent === 'Search the web and answer again')?.querySelector('.muted')?.textContent ?? '');
await page.click('#answer-card .dig-menu .menu-item:has-text("Search the web and answer again")');
await page.waitForFunction(() => document.querySelectorAll('#thread .answer-card').length === 2 && document.body.dataset.status === 'done', null, { timeout: 30000 });
const withWeb = { q: mock.server.lastSearch?.q, msgs: mock.server.lastRequest?.messages ?? [], sources: await page.evaluate(() => document.querySelectorAll('#sources li').length) };
const withWebSys = withWeb.msgs.find((m) => m.role === 'system')?.content ?? '';
const withWebUser = withWeb.msgs[withWeb.msgs.length - 1]?.content ?? '';
await page.click('#attachments .attachment .x');
const toggleFreed = await page.evaluate(() => !document.getElementById('ground').disabled);
check('a file question skips the web even with the toggle ticked; Dig deeper adds results to the file, cited',
  toggleFree.checked && !toggleFree.disabled && toggleWithFile.disabled && /file is attached/.test(toggleWithFile.title)
    && !fileAsk.searched && fileAsk.sources === 0 && fileAsk.sys.includes('File "brief.txt"') && !/web/.test(fileAsk.stats) && /file says/.test(fileDigNote)
    && withWeb.q === 'Give me some bullets from the document' && withWebSys.includes('File "brief.txt"') && /Answer from the file or page given above first/.test(withWebSys)
    && withWebUser.includes('MOCK SNIPPET ALPHA') && withWeb.sources === 2 && withWeb.msgs.length === 2 && toggleFreed,
  `searched while attached=${fileAsk.searched}; dig note="${fileDigNote}"; re-ask q="${withWeb.q}" msgs=${withWeb.msgs.length} sources=${withWeb.sources}; toggle freed=${toggleFreed}`);


// 19. inbox, feed, and Jira widgets, seeded through storage the way the agenda test does. The same mock server
// stands in for Gmail, the feeds, and Jira; the e2e build holds a host permission for it.
await page.goto(`${base}?e2e=1&cloud=${mock.port}`);
await page.waitForSelector('#recipe-chips .chip');
await page.evaluate(async (port) => {
  const m = `http://127.0.0.1:${port}`;
  const layout = { version: 1, focus: false, ask: 'top', arrangement: 'stack', columns: 'auto', showRecipes: true, widgets: [
    { id: 'email-feed-test', type: 'email', config: { name: 'Inbox', provider: 'gmail-feed', count: 8, filter: 'Receipts', match: '', account: 0, endpoint: m } },
    { id: 'email-api-test', type: 'email', config: { name: 'API mail', provider: 'gmail-api', count: 8, filter: 'from:stripe.com', match: '', account: 0, clientId: 'test-client', endpoint: m } },
    { id: 'feed-test', type: 'feed', config: { name: 'Reading', count: 20, testQueryUrl: `${m}/query`, sources: [{ id: 's1', kind: 'rss', url: `${m}/rss` }, { id: 's2', kind: 'rss', url: `${m}/site` }, { id: 's3', kind: 'query', provider: 'hn', q: 'local-first' }] } },
    { id: 'jira-test', type: 'jira', config: { name: 'Jira', site: m, email: 'dylan@example.com', token: 'jira-token', auth: 'basic', jql: 'assignee = currentUser()', count: 10 } },
  ] };
  await chrome.storage.local.set({ 'fogar.layout': layout, 'fogar.email.auth.test-client': { accessToken: 'gmail-token', expiresAt: Date.now() + 3600e3, clientId: 'test-client' } });
}, mock.port);
await page.reload();
await page.waitForSelector('.widget[data-id="email-feed-test"] .mail-row', { timeout: 15000 });
const mailFeed = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('.widget[data-id="email-feed-test"] .mail-row')].map((r) => ({ from: r.querySelector('.from')?.textContent, subj: r.querySelector('.subj')?.textContent, unread: r.classList.contains('unread'), href: r.href })),
  status: document.querySelector('.widget[data-id="email-feed-test"] .small-note')?.textContent ?? '',
}));
check('inbox: the Gmail unread feed renders sender, subject, and thread links; the label is the feed path',
  mailFeed.rows.length === 3 && mailFeed.rows[0].from === 'Globex Billing' && mailFeed.rows[0].subj === 'Quarterly invoice' && mailFeed.rows.every((r) => r.unread) && /#all\/18f0a1b2c3d4e5f6$/.test(mailFeed.rows[0].href) && mock.server.lastGmail?.label === 'Receipts' && /3 unread in “Receipts”/.test(mailFeed.status),
  `${mailFeed.rows.length} rows; label=${mock.server.lastGmail?.label}; status="${mailFeed.status.slice(0, 40)}"`);
await page.waitForSelector('.widget[data-id="email-api-test"] .mail-row', { timeout: 15000 });
const mailApi = await page.evaluate(() => [...document.querySelectorAll('.widget[data-id="email-api-test"] .mail-row')].map((r) => ({ from: r.querySelector('.from')?.textContent, subj: r.querySelector('.subj')?.textContent, snip: r.querySelector('.snip')?.textContent, unread: r.classList.contains('unread'), href: r.href })));
check('inbox: the Gmail API path sends the bearer token and the search, shows read and unread mail',
  mailApi.length === 2 && mock.server.lastGmailApi?.auth === 'Bearer gmail-token' && mock.server.lastGmailApi?.q === 'from:stripe.com' && mailApi[0].from === 'Stripe' && mailApi[0].subj === 'Payout sent' && mailApi[0].unread && !mailApi[1].unread && /\$1,250\.00 & a receipt/.test(mailApi[0].snip) && /#all\/t1$/.test(mailApi[0].href),
  `${JSON.stringify(mailApi[0]).slice(0, 120)}; auth=${mock.server.lastGmailApi?.auth}`);
await page.waitForSelector('.widget[data-id="feed-test"] .feed-item', { timeout: 15000 });
const feedState = await page.evaluate(async () => {
  const rows = [...document.querySelectorAll('.widget[data-id="feed-test"] .feed-item')];
  const layout = (await chrome.storage.local.get('fogar.layout'))['fogar.layout'];
  return { titles: rows.map((r) => r.querySelector('.t')?.textContent), metas: rows.map((r) => r.querySelector('.meta')?.textContent), fresh: rows.filter((r) => r.classList.contains('new')).length, discovered: layout.widgets.find((w) => w.id === 'feed-test').config.sources[1].url, status: document.querySelector('.widget[data-id="feed-test"] .small-note')?.textContent ?? '' };
});
check('feed: RSS, Atom via a site page, and a search merge newest first, one copy of a shared link, sources named',
  feedState.titles.join('|') === 'Gamma entry|Alpha post|Result for local-first|Beta post|Shared post' && /Mock Atom/.test(feedState.metas[0]) && /Mock RSS · Ada/.test(feedState.metas[1]) && /Search: local-first/.test(feedState.metas[2]) && /\/atom$/.test(feedState.discovered) && mock.server.lastQuery?.q === 'local-first' && mock.server.lastQuery?.provider === 'hn' && /5 items from 3 sources/.test(feedState.status),
  `${feedState.titles.join(' | ')}; discovered=${feedState.discovered}`);
await page.hover('.widget[data-id="feed-test"]');
await page.click('.widget[data-id="feed-test"] .feed-mark');
await page.waitForFunction(() => document.querySelectorAll('.widget[data-id="feed-test"] .feed-item.new').length === 0, null, { timeout: 5000 }).catch(() => {});
const freshAfter = await page.evaluate(() => document.querySelectorAll('.widget[data-id="feed-test"] .feed-item.new').length);
check('feed: everything is new at first, "Mark read" clears the dots', feedState.fresh === 5 && freshAfter === 0, `${feedState.fresh} → ${freshAfter}`);
await page.waitForSelector('.widget[data-id="jira-test"] .jira-row', { timeout: 15000 });
const jiraState = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('.widget[data-id="jira-test"] .jira-row')].map((r) => ({ key: r.querySelector('.jira-key')?.textContent, sum: r.querySelector('.jira-sum')?.textContent, status: r.querySelector('.jira-status')?.textContent, cat: r.querySelector('.jira-status')?.dataset.cat, meta: r.querySelector('.jira-meta')?.textContent, href: r.href })),
  status: document.querySelector('.widget[data-id="jira-test"] .small-note')?.textContent ?? '',
}));
check('jira: issues from a JQL query render with status and meta; basic auth from email and token; site links',
  jiraState.rows.length === 2 && jiraState.rows[0].key === 'FOG-12' && jiraState.rows[0].status === 'In Progress' && jiraState.rows[0].cat === 'indeterminate' && /Task · High priority · Dylan Roy/.test(jiraState.rows[0].meta) && /\/browse\/FOG-12$/.test(jiraState.rows[0].href)
    && mock.server.lastJira?.jql === 'assignee = currentUser()' && mock.server.lastJira?.auth === `Basic ${Buffer.from('dylan@example.com:jira-token').toString('base64')}` && mock.server.lastJira?.path === '/rest/api/3/search/jql',
  `${jiraState.rows.map((r) => r.key).join(', ')}; auth ok=${mock.server.lastJira?.auth?.startsWith('Basic ')}`);

// 20. LLM Chat: add from the menu, add an OpenAI-compatible model through the settings form, chat with history, persist
await page.click('#widget-add');
await page.click('#widget-menu .menu-item[data-widget="chat"]');
await page.waitForSelector('.widget[data-type="chat"] .chat-input');
await page.hover('.widget[data-type="chat"]');
await page.click('.widget[data-type="chat"] .ctl[title="Settings"]');
await page.waitForSelector('.widget[data-type="chat"] .widget-body .row-head select');
await page.selectOption('.widget[data-type="chat"] .widget-body .row-head select', 'custom');
await page.click('.widget[data-type="chat"] .widget-body .row-head button:has-text("Add")');
await page.waitForSelector('.widget[data-type="chat"] .profile-editor input[type="url"]');
await page.fill('.widget[data-type="chat"] .profile-editor input[type="url"]', `http://127.0.0.1:${mock.port}/v1`);
await page.fill('.widget[data-type="chat"] .profile-editor input[type="password"]', 'chat-key');
await page.click('.widget[data-type="chat"] .profile-editor button:has-text("Fetch models")');
await page.waitForFunction(() => /2 models/.test([...document.querySelectorAll('.widget[data-type="chat"] .profile-editor .muted')].map((n) => n.textContent).join(' ')), null, { timeout: 10000 });
const fetchedModel = await page.evaluate(() => document.querySelector('.widget[data-type="chat"] .profile-editor .model-row input')?.value);
await page.click('.widget[data-type="chat"] .profile-editor button:has-text("Save model")');
await page.waitForSelector('.widget[data-type="chat"] .profile-row');
await page.click('.widget[data-type="chat"] .widget-body .setup button:has-text("Done")');
await page.waitForSelector('.widget[data-type="chat"] .chat-input');
const customChoice = await page.evaluate(() => [...document.querySelector('.widget[data-type="chat"] .chat-model').options].find((o) => /Custom OpenAI/.test(o.text))?.value);
await page.selectOption('.widget[data-type="chat"] .chat-model', customChoice);
await page.fill('.widget[data-type="chat"] .chat-input', 'Hello widget');
await page.press('.widget[data-type="chat"] .chat-input', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('.widget[data-type="chat"] .msg.assistant').length === 1 && !document.querySelector('.widget[data-type="chat"] .msg.streaming') && /mock cloud says hello/.test(document.querySelector('.widget[data-type="chat"] .msg.assistant .bubble')?.textContent ?? ''), null, { timeout: 20000 });
const chatReq1 = mock.server.lastRequest;
await page.fill('.widget[data-type="chat"] .chat-input', 'Again please');
await page.press('.widget[data-type="chat"] .chat-input', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('.widget[data-type="chat"] .msg.assistant').length === 2 && !document.querySelector('.widget[data-type="chat"] .msg.streaming'), null, { timeout: 20000 });
const chatReq2 = mock.server.lastRequest;
await page.reload();
await page.waitForSelector('.widget[data-type="chat"] .msg');
const chatPersisted = await page.evaluate(() => ({ msgs: document.querySelectorAll('.widget[data-type="chat"] .msg').length, first: document.querySelector('.widget[data-type="chat"] .msg.user .bubble')?.textContent, model: document.querySelector('.widget[data-type="chat"] .chat-model')?.selectedOptions[0]?.text }));
check('llm chat: a model added through the form (models fetched from the endpoint) answers with the bearer key; history and the conversation persist',
  fetchedModel === 'mock-model' && chatReq1?.auth === 'Bearer chat-key' && chatReq1?.model === 'mock-model' && chatReq1?.messages?.[0]?.role === 'system' && chatReq1?.messages?.at(-1)?.content === 'Hello widget'
    && chatReq2?.messages?.length === 4 && /mock cloud says hello/.test(chatReq2?.messages?.[2]?.content ?? '') && chatPersisted.msgs === 4 && chatPersisted.first === 'Hello widget' && /Custom OpenAI/.test(chatPersisted.model),
  `model=${fetchedModel}; req1 ${chatReq1?.messages?.length} msgs; req2 ${chatReq2?.messages?.length} msgs; after reload ${chatPersisted.msgs} msgs, picker "${chatPersisted.model}"`);

// 20b. an Anthropic profile speaks the Messages API: key header, version, browser-access header, system, streamed reply
await page.hover('.widget[data-type="chat"]');
await page.click('.widget[data-type="chat"] .ctl[title="Settings"]');
await page.waitForSelector('.widget[data-type="chat"] .widget-body .row-head select');
await page.selectOption('.widget[data-type="chat"] .widget-body .row-head select', 'anthropic');
await page.click('.widget[data-type="chat"] .widget-body .row-head button:has-text("Add")');
await page.waitForSelector('.widget[data-type="chat"] .profile-editor input[type="url"]');
const anthropicDefaults = await page.evaluate(() => ({ endpoint: document.querySelector('.widget[data-type="chat"] .profile-editor input[type="url"]')?.value, model: document.querySelector('.widget[data-type="chat"] .profile-editor .model-row input')?.value, vision: document.querySelector('.widget[data-type="chat"] .profile-editor input[type="checkbox"]')?.checked }));
await page.fill('.widget[data-type="chat"] .profile-editor input[type="url"]', `http://127.0.0.1:${mock.port}/anthropic`);
await page.fill('.widget[data-type="chat"] .profile-editor input[type="password"]', 'sk-ant-test');
await page.click('.widget[data-type="chat"] .profile-editor button:has-text("Save model")');
await page.waitForFunction(() => document.querySelectorAll('.widget[data-type="chat"] .profile-row').length === 2);
await page.click('.widget[data-type="chat"] .widget-body .setup button:has-text("Done")');
await page.waitForSelector('.widget[data-type="chat"] .chat-input');
const claudeChoice = await page.evaluate(() => [...document.querySelector('.widget[data-type="chat"] .chat-model').options].find((o) => /Anthropic/.test(o.text))?.value);
await page.selectOption('.widget[data-type="chat"] .chat-model', claudeChoice);
await page.click('.widget[data-type="chat"] .chat-new');
await page.fill('.widget[data-type="chat"] .chat-input', 'Hi Claude');
await page.press('.widget[data-type="chat"] .chat-input', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('.widget[data-type="chat"] .msg.assistant').length === 1 && !document.querySelector('.widget[data-type="chat"] .msg.streaming') && /Claude mock reply/.test(document.querySelector('.widget[data-type="chat"] .msg.assistant .bubble')?.textContent ?? ''), null, { timeout: 20000 });
const a = mock.server.lastAnthropic;
check('llm chat: the Anthropic profile defaults to claude-opus-5 and streams through the Messages API with the right headers',
  anthropicDefaults.endpoint === 'https://api.anthropic.com' && anthropicDefaults.model === 'claude-opus-5' && anthropicDefaults.vision === true
    && a?.key === 'sk-ant-test' && a?.version === '2023-06-01' && a?.browser === 'true' && a?.body?.model === 'claude-opus-5' && a?.body?.stream === true && typeof a?.body?.system === 'string' && a?.body?.messages?.[0]?.role === 'user' && a?.body?.messages?.[0]?.content === 'Hi Claude',
  `defaults ${JSON.stringify(anthropicDefaults)}; headers key=${a?.key} v=${a?.version} browser=${a?.browser}; model=${a?.body?.model}`);

// 21. Post-its: add, write, drag within the board, pull one off onto another card so it becomes its own widget; persists
// Raw mouse events do not scroll, so the whole page has to fit the viewport for the drags below.
await page.setViewportSize({ width: 1280, height: 2600 });
await page.click('#widget-add');
await page.click('#widget-menu .menu-item[data-widget="postit"]');
await page.waitForSelector('.widget[data-type="postit"] .pnote');
await page.fill('.widget[data-type="postit"] .pnote textarea', 'buy milk');
await page.hover('.widget[data-type="postit"]');
await page.click('.widget[data-type="postit"] .pnote-add');
await page.waitForFunction(() => document.querySelectorAll('.widget[data-type="postit"] .pnote').length === 2);
const noteBefore = await page.evaluate(() => { const n = document.querySelectorAll('.widget[data-type="postit"] .pnote')[1]; return { left: parseFloat(n.style.left), top: parseFloat(n.style.top) }; });
const bar2 = await page.locator('.widget[data-type="postit"] .pnote').nth(1).locator('.pnote-bar').boundingBox();
await page.mouse.move(bar2.x + 40, bar2.y + 8);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(bar2.x + 40 + i * 15, bar2.y + 8 + i * 8);
await page.mouse.up();
const noteAfter = await page.evaluate(() => { const n = document.querySelectorAll('.widget[data-type="postit"] .pnote')[1]; return { left: parseFloat(n.style.left), top: parseFloat(n.style.top) }; });
await page.waitForTimeout(500); // the note text saves on a 300 ms debounce
await page.reload();
await page.waitForSelector('.widget[data-type="postit"] .pnote');
const notesReload = await page.evaluate(() => [...document.querySelectorAll('.widget[data-type="postit"] .pnote')].map((n) => ({ text: n.querySelector('textarea').value, left: parseFloat(n.style.left) })));
check('post-its: notes stack, a drag moves one across the board, text and positions persist',
  noteAfter.left - noteBefore.left > 100 && noteAfter.top - noteBefore.top > 50 && notesReload.length === 2 && notesReload[0].text === 'buy milk' && Math.abs(notesReload[1].left - noteAfter.left) < 2,
  `moved ${Math.round(noteAfter.left - noteBefore.left)}px right, ${Math.round(noteAfter.top - noteBefore.top)}px down; reload ${JSON.stringify(notesReload)}`);
const bar1 = await page.locator('.widget[data-type="postit"] .pnote').first().locator('.pnote-bar').boundingBox();
const chatCard = await page.locator('.widget[data-type="chat"]').boundingBox();
await page.mouse.move(bar1.x + 40, bar1.y + 8);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(bar1.x + 40 + ((chatCard.x + chatCard.width / 2) - (bar1.x + 40)) * i / 10, bar1.y + 8 + ((chatCard.y + 60) - (bar1.y + 8)) * i / 10);
const dropMark = await page.evaluate(() => !!document.querySelector('.widget[data-type="chat"].drop-before, .widget[data-type="chat"].drop-after'));
await page.mouse.up();
await page.waitForFunction(() => document.querySelectorAll('.widget[data-type="postit"]').length === 2, null, { timeout: 5000 }).catch(() => {});
const pulled = await page.evaluate(() => [...document.querySelectorAll('.widget[data-type="postit"]')].map((w) => ({ notes: [...w.querySelectorAll('.pnote textarea')].map((t) => t.value), title: w.querySelector('h2')?.textContent })));
check('post-its: pulling a note off the board onto another card makes it its own widget next to that card',
  dropMark && pulled.length === 2 && pulled.some((w) => w.notes.length === 1 && w.notes[0] === 'buy milk' && w.title === 'Post-it') && pulled.some((w) => w.notes.length === 1 && w.notes[0] === ''),
  `mark=${dropMark}; ${JSON.stringify(pulled)}`);

// 22. Canvas: a stroke, a box, text; undo and redo; the model redraws from the shape list and keeps the stroke; PNG
await page.click('#widget-add');
await page.click('#widget-menu .menu-item[data-widget="canvas"]');
await page.waitForSelector('.widget[data-type="canvas"] .cv-surface');
const cvCard = page.locator('.widget[data-type="canvas"]');
await cvCard.locator('.cv-surface').scrollIntoViewIfNeeded(); // mouse coordinates are viewport-relative and never scroll
const svgBox = await cvCard.locator('.cv-surface').boundingBox();
await page.mouse.move(svgBox.x + 60, svgBox.y + 60);
await page.mouse.down();
for (let i = 1; i <= 6; i++) await page.mouse.move(svgBox.x + 60 + i * 20, svgBox.y + 60 + i * 6);
await page.mouse.up();
await cvCard.locator('.cv-tool[data-tool="rect"]').click();
await page.mouse.move(svgBox.x + 250, svgBox.y + 80);
await page.mouse.down();
await page.mouse.move(svgBox.x + 330, svgBox.y + 140, { steps: 4 });
await page.mouse.up();
await cvCard.locator('.cv-tool[data-tool="text"]').click();
await page.mouse.click(svgBox.x + 100, svgBox.y + 200);
await page.waitForSelector('.widget[data-type="canvas"] .cv-textbox:not([hidden])');
await page.keyboard.type('Note');
await page.keyboard.press('Enter');
const drawn = await page.evaluate(() => { const g = document.querySelector('.widget[data-type="canvas"] .cv-surface g'); return { paths: g.querySelectorAll('path').length, rects: g.querySelectorAll('rect').length, texts: [...g.querySelectorAll('text')].map((t) => t.textContent) }; });
await cvCard.locator('.ctl[title="Undo"]').click();
const afterUndo = await page.evaluate(() => document.querySelectorAll('.widget[data-type="canvas"] .cv-surface g text').length);
await cvCard.locator('.ctl[title="Redo"]').click();
const afterRedo = await page.evaluate(() => document.querySelectorAll('.widget[data-type="canvas"] .cv-surface g text').length);
check('canvas: pen, box, and text tools draw shapes; undo and redo', drawn.paths === 1 && drawn.rects === 1 && drawn.texts.join() === 'Note' && afterUndo === 0 && afterRedo === 1, JSON.stringify({ ...drawn, afterUndo, afterRedo }));
await cvCard.locator('.cv-ask').fill('draw a house');
await cvCard.locator('.cv-go').click();
await page.waitForFunction(() => /shape/.test(document.querySelector('.widget[data-type="canvas"] .cv-status')?.textContent ?? ''), null, { timeout: 20000 });
const redrawn = await page.evaluate(() => { const g = document.querySelector('.widget[data-type="canvas"] .cv-surface g'); return { paths: g.querySelectorAll('path').length, rect: g.querySelector('rect')?.getAttribute('x'), texts: [...g.querySelectorAll('text')].map((t) => t.textContent), status: document.querySelector('.widget[data-type="canvas"] .cv-status')?.textContent }; });
const drawReq = mock.server.lastRequest;
await page.reload();
await page.waitForSelector('.widget[data-type="canvas"] .cv-surface g *');
const cvPersisted = await page.evaluate(() => document.querySelectorAll('.widget[data-type="canvas"] .cv-surface g [data-id]').length);
check('canvas: the model gets the shapes as data and its reply is drawn; the stroke survives by id; the drawing persists',
  /You edit a drawing/.test(drawReq?.messages?.[0]?.content ?? '') && /"type":"path","id":"/.test(drawReq?.messages?.at(-1)?.content ?? '') && /Instruction: draw a house/.test(drawReq?.messages?.at(-1)?.content ?? '')
    && redrawn.paths === 1 && redrawn.rect === '100' && redrawn.texts.join() === 'House' && /3 shapes/.test(redrawn.status) && cvPersisted === 3,
  `${JSON.stringify(redrawn)}; persisted ${cvPersisted}`);
await page.hover('.widget[data-type="canvas"]');
const [pngDl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('.widget[data-type="canvas"] .cv-png')]);
check('canvas: Save PNG downloads a PNG', pngDl.suggestedFilename().endsWith('.png') && readFileSync(await pngDl.path()).subarray(1, 4).toString() === 'PNG', pngDl.suggestedFilename());

// 23. Notebook: pages, a photo read by a vision model (the Settings cloud endpoint here), persistence
await page.click('#widget-add');
await page.click('#widget-menu .menu-item[data-widget="notebook"]');
await page.waitForSelector('.widget[data-type="notebook"] .nb-text');
await page.fill('.widget[data-type="notebook"] .nb-title', 'Groceries');
await page.fill('.widget[data-type="notebook"] .nb-text', 'eggs');
await page.click('.widget[data-type="notebook"] .nb-add');
await page.waitForFunction(() => document.querySelectorAll('.widget[data-type="notebook"] .nb-tab:not(.nb-add)').length === 2);
await page.selectOption('.widget[data-type="notebook"] .nb-reader', 'fogar-cloud');
const pngData = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 120; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 400, 120); x.fillStyle = '#000'; x.font = '48px sans-serif'; x.fillText('HELLO', 20, 80); return c.toDataURL('image/png').split(',')[1]; });
await page.setInputFiles('.widget[data-type="notebook"] .nb-file', { name: 'page.png', mimeType: 'image/png', buffer: Buffer.from(pngData, 'base64') });
await page.waitForFunction(() => /MOCK OCR TEXT/.test(document.querySelector('.widget[data-type="notebook"] .nb-text')?.value ?? ''), null, { timeout: 20000 });
const ocrReq = mock.server.lastRequest;
const nbState = await page.evaluate(() => ({ text: document.querySelector('.widget[data-type="notebook"] .nb-text')?.value, status: document.querySelector('.widget[data-type="notebook"] .nb-status')?.textContent, tabs: [...document.querySelectorAll('.widget[data-type="notebook"] .nb-tab:not(.nb-add)')].map((t) => t.textContent) }));
await page.click('.widget[data-type="notebook"] .nb-tab:not(.nb-add)');
const firstPage = await page.evaluate(() => document.querySelector('.widget[data-type="notebook"] .nb-text')?.value);
await page.waitForTimeout(500); // typed text saves on a debounce
await page.reload();
await page.waitForSelector('.widget[data-type="notebook"] .nb-tab');
const nbReload = await page.evaluate(() => [...document.querySelectorAll('.widget[data-type="notebook"] .nb-tab:not(.nb-add)')].map((t) => t.textContent));
check('notebook: pages switch and persist; a photo goes to the vision model as a downscaled JPEG and its text lands on the page',
  ocrReq?.hasImage === true && ocrReq?.stream !== true && /Transcribe every word/.test(ocrReq?.messages?.[0]?.content?.[0]?.text ?? '') && /MOCK OCR TEXT\nSecond line/.test(nbState.text) && /Read 8 words/.test(nbState.status) && nbState.tabs[0] === 'Groceries' && firstPage === 'eggs' && nbReload.length === 2 && nbReload[0] === 'Groceries',
  `image=${ocrReq?.hasImage}; status="${nbState.status}"; tabs ${nbReload.join(', ')}`);
if (process.env.OCR === '1') {
  // On this device: Tesseract inside the extension reads a rendered line of printed text. Slow (a few seconds); opt in.
  await page.selectOption('.widget[data-type="notebook"] .nb-reader', 'local');
  const bigPng = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1000; c.height = 300; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 1000, 300); x.fillStyle = '#000'; x.font = 'bold 72px Arial, sans-serif'; x.fillText('HELLO FOGAR 2026', 40, 170); return c.toDataURL('image/png').split(',')[1]; });
  await page.setInputFiles('.widget[data-type="notebook"] .nb-file', { name: 'printed.png', mimeType: 'image/png', buffer: Buffer.from(bigPng, 'base64') });
  await page.waitForFunction(() => /Read \d+ words on this device|No text found|cannot run/.test(document.querySelector('.widget[data-type="notebook"] .nb-status')?.textContent ?? ''), null, { timeout: 120000 }).catch(() => {});
  const local = await page.evaluate(() => ({ text: document.querySelector('.widget[data-type="notebook"] .nb-text')?.value ?? '', status: document.querySelector('.widget[data-type="notebook"] .nb-status')?.textContent ?? '' }));
  check('notebook: Tesseract inside the extension reads printed text on this device', /HELLO FOGAR 2026/.test(local.text) && /on this device/.test(local.status), `status="${local.status}" text="${local.text.slice(0, 40).replace(/\n/g, ' ')}"`);
}

// 24. Full screen: the canvas card fills the window; Escape brings it back; the page behind it does not scroll
await page.hover('.widget[data-type="canvas"]');
await page.click('.widget[data-type="canvas"] .ctl[title="Full screen"]');
await page.waitForSelector('.widget[data-type="canvas"].fullscreen');
await page.waitForFunction(() => getComputedStyle(document.querySelector('.widget.fullscreen .widget-controls')).opacity === '1', null, { timeout: 5000 }).catch(() => {});
const fs = await page.evaluate(() => { const c = document.querySelector('.widget.fullscreen'); const r = c.getBoundingClientRect(); return { type: c.dataset.type, covers: r.left === 0 && r.top === 0 && Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2, rootClass: document.documentElement.classList.contains('widget-fullscreen'), bodyOverflow: getComputedStyle(document.body).overflow, controlsVisible: getComputedStyle(c.querySelector('.widget-controls')).opacity === '1', exitTitle: c.querySelector('.ctl[title^="Exit full screen"]') !== null }; });
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.widget.fullscreen'), null, { timeout: 5000 }).catch(() => {});
const fsAfter = await page.evaluate(() => ({ any: !!document.querySelector('.widget.fullscreen'), rootClass: document.documentElement.classList.contains('widget-fullscreen'), cards: document.querySelectorAll('#widgets .widget').length }));
check('full screen: a widget fills the window with its controls shown; Escape restores the page',
  fs.type === 'canvas' && fs.covers && fs.rootClass && fs.bodyOverflow === 'hidden' && fs.controlsVisible && fs.exitTitle && !fsAfter.any && !fsAfter.rootClass && fsAfter.cards > 3,
  JSON.stringify({ fs, fsAfter }));
await page.setViewportSize({ width: 1280, height: 800 });

// 25. Writing: add the widget, feed it two samples (one typed, one dropped as a file), distill a voice with the mock
//     model, add a register whose rules ban em dashes, tighten a message in it; the prompt carries the profile, the
//     register's rules, and the operation; the em dash the model wrote is removed; everything persists across tabs
await page.evaluate(() => chrome.storage.local.set({ 'fogar.layout': { version: 1, widgets: [{ id: 'todos', type: 'todos', config: {} }], focus: false, ask: 'top', arrangement: 'stack', columns: 'auto', showRecipes: true } }));
await page.goto(`${base}?e2e=1&cloud=${mock.port}`);
await page.waitForSelector('#recipe-chips .chip');
await page.click('#widget-add');
await page.click('#widget-menu .menu-item[data-widget="writing"]');
await page.waitForSelector('.widget[data-type="writing"] .wr-text');
const wrPick = await page.evaluate(() => { const s = document.querySelector('.widget[data-type="writing"] .wr-model'); return { value: s?.value, text: s?.selectedOptions[0]?.text }; });
const wrHint = await page.evaluate(() => document.querySelector('.widget[data-type="writing"] .wr-hint')?.textContent ?? '');
await page.click('.widget[data-type="writing"] .wr-nav button:has-text("Voice")');
await page.waitForSelector('.widget[data-type="writing"] .wr-sample-text');
await page.fill('.widget[data-type="writing"] .wr-sample-text', 'Honestly, the export flow is done. Two small bugs left in restore; both are mine and both are easy.');
await page.fill('.widget[data-type="writing"] .wr-sample-source', 'Slack');
await page.click('.widget[data-type="writing"] .wr-add-sample');
const wrDt = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(['Dear Priya, thanks for the invoice. I will pay it Friday, from the maintenance reserve, as we discussed.'], 'email.txt', { type: 'text/plain' })); return d; });
await page.dispatchEvent('.widget[data-type="writing"] .wr-sample-text', 'drop', { dataTransfer: wrDt });
await page.waitForFunction(() => /Dear Priya/.test(document.querySelector('.widget[data-type="writing"] .wr-sample-text')?.value ?? ''), null, { timeout: 10000 });
await page.fill('.widget[data-type="writing"] .wr-sample-source', 'email');
await page.click('.widget[data-type="writing"] .wr-add-sample');
await page.waitForFunction(() => document.querySelectorAll('.widget[data-type="writing"] .wr-sample').length === 2);
const wrSamples = await page.evaluate(() => [...document.querySelectorAll('.widget[data-type="writing"] .wr-sample')].map((r) => ({ tag: r.querySelector('.wr-tag')?.textContent, meta: r.querySelector('.meta')?.textContent })));
await page.click('.widget[data-type="writing"] .wr-distill');
await page.waitForFunction(() => /^Voice profile v1/.test(document.querySelector('.widget[data-type="writing"] .wr-profile summary')?.textContent ?? ''), null, { timeout: 20000 });
const distillReq = mock.server.lastRequest;
const distillUser = distillReq?.messages?.at(-1)?.content ?? '';
const wrProfile = await page.evaluate(() => ({ text: document.querySelector('.widget[data-type="writing"] .wr-profile-text')?.textContent ?? '', summary: document.querySelector('.widget[data-type="writing"] .wr-profile summary')?.textContent ?? '', nav: document.querySelector('.widget[data-type="writing"] .wr-nav button:nth-child(2)')?.textContent, note: document.querySelector('.widget[data-type="writing"] .wr-run .wr-status')?.textContent ?? '' }));
check('writing: a typed sample and a dropped file go to the model as one distill prompt; the profile comes back versioned and shown',
  wrPick.value === 'fogar-cloud' && /Fogar cloud/.test(wrPick.text ?? '') && /No voice yet/.test(wrHint)
    && wrSamples.length === 2 && wrSamples[0].tag === 'slack' && /\d+ words/.test(wrSamples[0].meta ?? '') && wrSamples[1].tag === 'email'
    && /voice analyst/.test(distillReq?.messages?.[0]?.content ?? '') && /\[Sample 1 · slack\]\nHonestly, the export flow/.test(distillUser) && /\[Sample 2 · email\]\nDear Priya/.test(distillUser) && /## Author\nYou\n/.test(distillUser) && /under 700 words/.test(distillUser)
    && /^### Diction & vocabulary/.test(wrProfile.text) && /from 2 samples/.test(wrProfile.summary) && wrProfile.nav === 'Voice · v1' && /Voice v1 is ready/.test(wrProfile.note),
  `pick="${wrPick.text}"; samples ${JSON.stringify(wrSamples)}; summary="${wrProfile.summary.slice(0, 60)}"`);

await page.click('.widget[data-type="writing"] .wr-nav button:has-text("Registers")');
await page.waitForSelector('.widget[data-type="writing"] .wr-register-row');
const wrRegsBefore = await page.evaluate(() => [...document.querySelectorAll('.widget[data-type="writing"] .wr-register-row strong')].map((n) => n.textContent));
await page.click('.widget[data-type="writing"] .wr-add-register');
await page.fill('.widget[data-type="writing"] .wr-reg-name', 'LinkedIn');
await page.fill('.widget[data-type="writing"] .wr-reg-formality', 'plainspoken, first person');
await page.fill('.widget[data-type="writing"] .wr-reg-length', 'under 120 words');
await page.fill('.widget[data-type="writing"] .wr-reg-notes', 'no em dashes; no hashtags');
await page.click('.widget[data-type="writing"] .wr-editor button:has-text("Save register")');
await page.waitForFunction(() => document.querySelectorAll('.widget[data-type="writing"] .wr-register-row').length === 4);
const wrRegs = await page.evaluate(() => ({ names: [...document.querySelectorAll('.widget[data-type="writing"] .wr-register-row strong')].map((n) => n.textContent), inUse: document.querySelector('.widget[data-type="writing"] .wr-register-row:has(.wr-inuse) strong')?.textContent, nav: document.querySelector('.widget[data-type="writing"] .wr-nav button:nth-child(3)')?.textContent }));
await page.click('.widget[data-type="writing"] .wr-nav button:has-text("Write")');
await page.waitForSelector('.widget[data-type="writing"] .wr-text');
const wrSelected = await page.evaluate(() => document.querySelector('.widget[data-type="writing"] .wr-register')?.selectedOptions[0]?.text);
await page.click('.widget[data-type="writing"] .wr-ops button:has-text("Tighten")');
await page.fill('.widget[data-type="writing"] .wr-text', 'so we shipped the thing, finally, after a lot of back and forth');
await page.fill('.widget[data-type="writing"] .wr-instruction', 'keep it under two lines');
await page.click('.widget[data-type="writing"] .wr-go');
await page.waitForFunction(() => { const w = document.querySelector('.widget[data-type="writing"]'); return !!w && !w.querySelector('.wr-out.streaming') && /Sounds like you/.test(w.querySelector('.wr-out-text')?.textContent ?? ''); }, null, { timeout: 20000 });
const wrReq = mock.server.lastRequest; const wrSys = wrReq?.messages?.[0]?.content ?? ''; const wrUser = wrReq?.messages?.at(-1)?.content ?? '';
const wrOut = await page.evaluate(() => ({ text: document.querySelector('.widget[data-type="writing"] .wr-out-text')?.textContent, meta: document.querySelector('.widget[data-type="writing"] .wr-out-meta')?.textContent, status: document.querySelector('.widget[data-type="writing"] .wr-run .wr-status')?.textContent }));
check('writing: a new register with rules is saved and selected; the run carries profile, register, rules, and operation; the em dash the model wrote is removed because the register bans it',
  wrRegsBefore.join() === 'Email,Chat,Essay' && wrRegs.names.join() === 'Email,Chat,Essay,LinkedIn' && wrRegs.inUse === 'LinkedIn' && wrRegs.nav === 'Registers · 4' && wrSelected === 'LinkedIn'
    && /sounds like a specific author/.test(wrSys) && wrReq?.messages?.length === 2 && /### Diction & vocabulary/.test(wrUser)
    && /## Register: LinkedIn\nFormality: plainspoken, first person\. Length: under 120 words\. Rules, follow these EXACTLY[^\n]*no em dashes; no hashtags/.test(wrUser)
    && /## Operation: tighten/.test(wrUser) && /## Instruction from the user[^\n]*\nkeep it under two lines/.test(wrUser) && /## Source material\nso we shipped the thing, finally/.test(wrUser)
    && wrOut.text === 'Sounds like you, and nobody else.' && /^In your voice · LinkedIn · tighten · voice v1 · Fogar cloud/.test(wrOut.meta ?? '') && /em dashes removed/.test(wrOut.status ?? ''),
  `regs=${wrRegs.names.join(',')} sel="${wrSelected}" out="${wrOut.text}" meta="${wrOut.meta}"`);

await page.reload();
await page.waitForSelector('.widget[data-type="writing"] .wr-out-text');
const wrAfter = await page.evaluate(async () => {
  const w = document.querySelector('.widget[data-type="writing"]');
  const key = `fogar.widget.${w.dataset.id}`;
  const stored = (await chrome.storage.local.get(key))[key];
  return { input: w.querySelector('.wr-text')?.value, out: w.querySelector('.wr-out-text')?.textContent, register: w.querySelector('.wr-register')?.selectedOptions[0]?.text, op: w.querySelector('.wr-ops [aria-pressed="true"]')?.textContent, samples: stored?.samples?.length, version: stored?.profile?.version, registers: stored?.registers?.length, hint: !!w.querySelector('.wr-hint'), brand: w.querySelector('.wr-brand a')?.href };
});
check('writing: samples, profile, registers, the register and operation in use, the text, and the last result persist across tabs; the card credits Dickens',
  wrAfter.input === 'so we shipped the thing, finally, after a lot of back and forth' && wrAfter.out === 'Sounds like you, and nobody else.' && wrAfter.register === 'LinkedIn' && wrAfter.op === 'Tighten' && wrAfter.samples === 2 && wrAfter.version === 1 && wrAfter.registers === 4 && !wrAfter.hint && /^https:\/\/dickens\.ai\//.test(wrAfter.brand ?? ''),
  JSON.stringify(wrAfter));

mock.server.close();
await context.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
const interesting = logs.filter((l) => process.env.VERBOSE === '1' || /pageerror|\[error\]|refused|csp|blocked|fogar\]/i.test(l)).slice(-30);
if (interesting.length) console.log('console:\n  ' + interesting.join('\n  '));
process.exit(failed.length ? 1 : 0);

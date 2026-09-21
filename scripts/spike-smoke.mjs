// Loads the built extension into Chromium, opens the new tab page in smoke mode, and waits for
// the 1 MB test model to download, load, and stream an answer. Proves wllama runs under MV3 CSP.
// Usage: npm run build && npm run test:spike   (add GPU=1 to try the WebGPU path)
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockOpenAI } from './mock-openai.mjs';

const ext = resolve('.output/chrome-mv3');
const userDataDir = mkdtempSync(join(tmpdir(), 'fogar-smoke-'));
const headless = process.env.HEADED !== '1';
const gpu = process.env.GPU === '1' ? '1' : '0';
const model = process.env.MODEL || 'smoke';

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--enable-unsafe-webgpu'],
});
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
const page = await context.newPage();
const logs = [];
let hfRequests = 0; let ggufDownloads = 0; const warmUrls = [];
let warmPhase = false;
page.on('response', (r) => {
  const url = r.url();
  if (!/huggingface|hf\.co/.test(url)) return;
  hfRequests++;
  if (warmPhase) warmUrls.push(`${r.request().method()} ${r.status()} ${url.replace(/^https:\/\//, '').slice(0, 90)}`);
  if (r.request().method() === 'GET' && r.status() === 200 && /\.gguf/.test(url)) ggufDownloads++;
});
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const t0 = Date.now();
await page.goto(`chrome-extension://${extId}/newtab.html?smoke=1&gpu=${gpu}&model=${model}`);
try {
  await page.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.status ?? ''), null, { timeout: 600000 });
} catch {
  logs.push('[smoke] timed out waiting for done/error');
}
const status = await page.evaluate(() => document.body.dataset.status);
const answer = await page.evaluate(() => document.getElementById('answer')?.textContent ?? '');
const stats = await page.evaluate(() => document.getElementById('stats')?.textContent ?? '');
const statusLine = await page.evaluate(() => document.getElementById('status')?.textContent ?? '');

// Warm reload: the same model must come from OPFS with no Hugging Face traffic.
const coldRequests = hfRequests; const coldDownloads = ggufDownloads; hfRequests = 0; ggufDownloads = 0; warmPhase = true;
const t1 = Date.now();
await page.reload();
let warmStatus = 'n/a';
try {
  await page.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.status ?? ''), null, { timeout: 120000 });
  warmStatus = await page.evaluate(() => document.body.dataset.status);
} catch { warmStatus = 'timeout'; }
const warmMs = Date.now() - t1;
const warmRequests = hfRequests; const warmDownloads = ggufDownloads;

// Cloud mode: point the page at a local OpenAI-compatible mock and check the SSE parser end to end.
const mock = await startMockOpenAI();
let cloudAnswer = ''; let cloudStatus = 'n/a';
try {
  await page.goto(`chrome-extension://${extId}/newtab.html?smoke=1&cloud=${mock.port}`);
  await page.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.status ?? ''), null, { timeout: 30000 });
  cloudStatus = await page.evaluate(() => document.body.dataset.status);
  cloudAnswer = await page.evaluate(() => document.getElementById('answer')?.textContent ?? '');
} catch { cloudStatus = 'timeout'; }
mock.server.close();
const cloudOk = cloudStatus === 'done' && cloudAnswer.includes('mock cloud says hello') && mock.server.lastRequest?.auth === 'Bearer test-key' && mock.server.lastRequest?.stream === true;
await context.close();

console.log(`status: ${status}  (${Date.now() - t0} ms wall)`);
console.log(`status line: ${statusLine}`);
console.log(`stats: ${stats}`);
console.log(`answer: ${answer.slice(0, 200).replace(/\n/g, ' ')}`);
console.log(`cold: ${coldRequests} Hugging Face responses (${coldDownloads} GGUF downloads) · warm reload: ${warmStatus} in ${warmMs} ms, ${warmRequests} responses (${warmDownloads} GGUF downloads)`);
if (warmUrls.length) console.log('warm requests:\n  ' + warmUrls.join('\n  '));
console.log(`cloud: ${cloudStatus} · answer "${cloudAnswer}" · auth header ${mock.server.lastRequest?.auth ?? 'missing'} · ${cloudOk ? 'OK' : 'FAILED'}`);
const interesting = logs.filter((l) => process.env.VERBOSE === '1' || /error|refused|csp|fogar|wllama|worker|gpu|multithread|thread|removeEntry|opfs|blocked/i.test(l)).slice(-40);
if (interesting.length) console.log('console:\n  ' + interesting.join('\n  '));
process.exit(status === 'done' && answer.length > 0 && warmStatus === 'done' && warmDownloads === 0 && cloudOk ? 0 : 1);

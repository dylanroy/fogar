// End-to-end check of the web app. Serves .output/web with the headers from web/_headers, opens it in Chromium, and
// checks what a phone needs: cross-origin isolation (wllama's threads); storage that survives a reload; the service
// worker, after which the server is stopped and everything must come from the cache; the local model from a web
// origin (the 1 MB smoke model downloaded from Hugging Face under CORS, then loaded again with the network off,
// with no request allowed); the manifest and icons.
// Usage: npm run test:web   (SKIP_BUILD=1 to reuse .output/web, HEADED=1 to watch, VERBOSE=1 for every console line)
// BASE=https://app.fogar.ai runs the same checks against a deploy; there the "server stopped" step goes offline instead.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';

const OUT = '.output/web';
const LIVE = process.env.BASE;
if (!LIVE && process.env.SKIP_BUILD !== '1') {
  const build = spawnSync('node', ['scripts/build-web.mjs'], { stdio: 'inherit' });
  if (build.status !== 0) { console.error('web build failed'); process.exit(1); }
}

/** web/_headers the way Cloudflare reads it: a path pattern on its own line, then the headers indented under it. */
function parseHeaders(text) {
  const rules = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) rules.push({ pattern: line.trim(), headers: {} });
    else { const i = line.indexOf(':'); rules[rules.length - 1].headers[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  }
  return rules;
}
const matches = (pattern, path) => (pattern.endsWith('/*') ? path.startsWith(pattern.slice(0, -1)) || path === pattern.slice(0, -2) : pattern === path);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.txt': 'text/plain' };

const sockets = new Set();
function serve() {
  const rules = parseHeaders(readFileSync(join(OUT, '_headers'), 'utf8'));
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(OUT, path === '/' ? '/index.html' : path));
    if (!file.startsWith(normalize(OUT)) || path === '/_headers' || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    for (const r of rules) if (matches(r.pattern, path)) for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const server = LIVE ? null : await serve();
const BASE = (LIVE ?? `http://127.0.0.1:${server.address().port}`).replace(/\/$/, '');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const browser = await chromium.launch({ channel: 'chromium', headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ serviceWorkers: 'allow' });
const page = await context.newPage();
const logs = [];
let hf = 0;
page.on('console', (m) => { if (m.type() === 'verbose') return; logs.push(`[${m.type()}] ${m.text()}`); if (process.env.VERBOSE === '1') console.log(`      ${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url().slice(0, 120)} ${r.failure()?.errorText ?? ''}`));
page.on('response', (r) => { if (/huggingface|hf\.co/.test(r.url())) hf++; });
const status = () => page.evaluate(() => document.body.dataset.status);
const text = (id) => page.evaluate((i) => document.getElementById(i)?.textContent ?? '', id);
const waitDone = (timeout) => page.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.status ?? ''), null, { timeout });
const shell = () => page.waitForSelector('#recipe-chips .chip', { timeout: 20000 });

try {
  // 1. The page, its headers, and what the phone needs to install it
  const first = await page.goto(`${BASE}/?e2e=1`);
  await shell();
  const isolated = await page.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer === 'function');
  check('page opens cross-origin isolated', first.headers()['cross-origin-embedder-policy'] === 'require-corp' && isolated, `COEP ${first.headers()['cross-origin-embedder-policy']}, CSP ${first.headers()['content-security-policy'] ? 'set' : 'missing'}`);
  const manifest = await (await context.request.get(`${BASE}/manifest.webmanifest`)).json().catch(() => null);
  const icons = await Promise.all(['/icon/192.png', '/icon/512.png', '/icon/512-maskable.png', '/icon/180.png'].map(async (p) => (await context.request.get(`${BASE}${p}`)).status()));
  check('installable: title, manifest, icons', (await page.title()) === 'Fogar' && manifest?.display === 'standalone' && icons.every((s) => s === 200) && (await page.evaluate(() => !!document.querySelector('link[rel="manifest"]') && !!document.querySelector('link[rel="apple-touch-icon"]'))));
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('#widget-menu [data-widget]')).map((b) => b.dataset.widget));
  check('the Add menu hides what a web page cannot run', !['sessions', 'email', 'feed', 'jira', 'agenda'].some((w) => menu.includes(w)) && menu.includes('todos') && menu.includes('writing'), `${menu.length} widgets offered`);

  // 2. Storage: a todo written through the page survives a reload
  await page.fill('#prompt', 'todo: Pack the charger');
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => /Pack the charger/.test(document.getElementById('todo-list')?.textContent ?? ''), null, { timeout: 10000 });
  await page.reload(); await shell();
  check('a todo survives a reload (IndexedDB)', await page.evaluate(() => /Pack the charger/.test(document.getElementById('todo-list')?.textContent ?? '')));

  // 3. The service worker installs and precaches the app and the model runtime
  // "active" is set while the worker is still activating and before it claims the page, and the cache exists, empty,
  // from the moment addAll starts: wait until the page is controlled and the precache has landed. Polled from here,
  // since waitForFunction does not await an async predicate.
  const swState = () => page.evaluate(async () => ({ controller: !!navigator.serviceWorker.controller, entries: Math.max(0, ...(await Promise.all((await caches.keys()).map(async (n) => (await (await caches.open(n)).keys()).length)))) }));
  let sw = await swState();
  for (const deadline = Date.now() + 90000; (!sw.controller || sw.entries < 20) && Date.now() < deadline; sw = await swState()) await page.waitForTimeout(250);
  check('service worker in control, app precached', sw.controller && sw.entries >= 20, `${sw.entries} entries`);

  // 3b. The compat build, for browsers without JSPI (Safari before 27): a context that hides the feature must load the
  //     model from the local compat files, never from a CDN. Before the server goes away: these files are not precached.
  {
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    await ctx.addInitScript(() => { delete WebAssembly.Suspending; });
    const cp = await ctx.newPage();
    const fetched = new Set(); const cdn = [];
    cp.on('request', (r) => { const u = r.url(); if (/wllama.*compat/.test(u)) fetched.add(new URL(u).pathname); if (/jsdelivr\.net/.test(u)) cdn.push(u); });
    cp.on('console', (m) => { if (m.type() !== 'verbose') logs.push(`[compat ${m.type()}] ${m.text().slice(0, 160)}`); });
    const t1 = Date.now();
    await cp.goto(`${BASE}/?smoke=1&gpu=0&model=smoke`);
    try { await cp.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.status ?? ''), null, { timeout: 180000 }); } catch { logs.push('[compat] timed out'); }
    const st = await cp.evaluate(() => document.body.dataset.status);
    const ans = await cp.evaluate(() => document.getElementById('answer')?.textContent ?? '');
    check('the compat build (no JSPI) loads from local files and answers', st === 'done' && ans.length > 0 && fetched.has('/wllama/wllama-compat.wasm') && fetched.has('/wllama/llama-worker-compat.js') && cdn.length === 0, `${Date.now() - t1} ms, ${[...fetched].join(' ')}${cdn.length ? ', CDN: ' + cdn[0] : ''}`);
    await ctx.close();
  }

  // 4. From here on nothing comes from the server: stop it (or go offline against a deploy)
  if (server) { server.close(); for (const s of sockets) s.destroy(); } else await context.setOffline(true);
  await page.reload(); await shell();
  check('the app opens with the server gone, still isolated, data intact', await page.evaluate(() => crossOriginIsolated && /Pack the charger/.test(document.getElementById('todo-list')?.textContent ?? '')));
  if (!server) await context.setOffline(false);

  // 5. The local model from a web origin: downloaded from Hugging Face under CORS, run on the CPU
  let t0 = Date.now(); hf = 0;
  await page.goto(`${BASE}/?smoke=1&gpu=0&model=smoke`);
  try { await waitDone(180000); } catch { logs.push('[smoke] timed out'); }
  const answer = await text('answer');
  check('the smoke model downloads from Hugging Face and streams an answer', (await status()) === 'done' && answer.length > 0, `${Date.now() - t0} ms, ${hf} Hugging Face responses, ${await text('stats')}`);
  console.log(`      answer: ${answer.slice(0, 100).replace(/\n/g, ' ')}`);

  // 6. The same model with the network off: served from OPFS, and not one request
  await context.setOffline(true); hf = 0; t0 = Date.now();
  await page.goto(`${BASE}/?smoke=1&gpu=0&model=smoke`);
  try { await waitDone(120000); } catch { logs.push('[smoke offline] timed out'); }
  check('a cached model loads and answers with no network at all', (await status()) === 'done' && hf === 0 && (await text('answer')).length > 0, `${Date.now() - t0} ms, ${hf} requests to Hugging Face`);
  await context.setOffline(false);
} catch (err) {
  check(`aborted: ${err.message.split('\n')[0]}`, false);
}

await browser.close();
if (server) server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('\nLast console lines:'); for (const l of logs.slice(-40)) console.log('  ' + l); process.exit(1); }

// Feasibility spike: host wllama in an offscreen document. Run in a FRESH profile (Chrome keeps a persistent
// profile's extension service worker until the version changes, so a reused profile runs stale background code).
// Usage: PROFILE=$(mktemp -d) MODEL=smoke node scripts/offscreen-spike.mjs
import { chromium } from 'playwright';
import { resolve } from 'node:path';
const ext = resolve('.output/chrome-mv3');
const model = process.env.MODEL || 'smoke';
const context = await chromium.launchPersistentContext(process.env.PROFILE || '/tmp/fogar-eval-profile', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--enable-unsafe-webgpu'] });
let sw = context.serviceWorkers()[0]; if (!sw) sw = await context.waitForEvent('serviceworker');
sw.on('console', (m) => console.log('[sw]', m.text().slice(0, 200)));
context.on('page', (p) => p.on('console', (m) => console.log('[page]', m.text().slice(0, 200))));
const page = await context.newPage();
page.on('console', (m) => { if (/fogar|error/i.test(m.text())) console.log('[newtab]', m.text().slice(0, 200)); });
await page.goto(`chrome-extension://${new URL(sw.url()).host}/newtab.html?e2e=1`);
await page.waitForSelector('#recipe-chips .chip');
const result = await page.evaluate(async (model) => {
  const ensure = await chrome.runtime.sendMessage({ type: 'offscreen.ensure' });
  const res = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: 'timeout waiting for offscreen result' }), 60000);
    chrome.runtime.onMessage.addListener(function l(msg) { if (msg?.type === 'offscreen.result') { clearTimeout(timer); chrome.runtime.onMessage.removeListener(l); resolve(msg.result); } });
    setTimeout(() => chrome.runtime.sendMessage({ type: 'offscreen.spike', modelId: model, gpu: true }).catch(() => {}), 800);
  });
  return { ensure, res };
}, model);
console.log(JSON.stringify(result, null, 2));
await context.close();

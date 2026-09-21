// Store screenshots (1280×800), a promo tile (440×280), and a marquee (1400×560), from the real extension.
// Uses a profile where the 4B model is already cached (PROFILE=/tmp/fogar-eval-profile after scripts/eval-models.mjs),
// so the answers in the screenshots are real model output. Falls back to a fresh profile and the smoke model.
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockServer } from './mock-openai.mjs';

const ext = resolve('.output/chrome-mv3');
mkdirSync('store/screenshots', { recursive: true });
const profile = process.env.PROFILE || mkdtempSync(join(tmpdir(), 'fogar-store-'));
const model = process.env.MODEL || 'qwen3.5-4b';
const mock = await startMockServer();
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--enable-unsafe-webgpu'],
});
let sw = context.serviceWorkers()[0]; if (!sw) sw = await context.waitForEvent('serviceworker');
const page = await context.newPage();
const base = `chrome-extension://${new URL(sw.url()).host}/newtab.html`;
const waitDone = () => page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: 15 * 60 * 1000 });
const shot = (name) => page.screenshot({ path: `store/screenshots/${name}.png` });

// 5. first run (fresh state). The e2e page saves its settings asynchronously, so let it settle before clearing.
await page.goto(`${base}?e2e=1`);
await page.waitForSelector('#recipe-chips .chip');
await page.waitForTimeout(600);
await page.evaluate(() => chrome.storage.local.clear());
await page.goto(base);
await page.waitForSelector('#firstrun:not([hidden])', { timeout: 10000 });
await shot('05-firstrun');

// seed state: onboarded, model, widgets, todos, reminders. Let the e2e page finish its own save first.
await page.goto(`${base}?e2e=1`);
await page.waitForSelector('#recipe-chips .chip');
await page.waitForTimeout(600);
await page.evaluate(async ({ port, model }) => {
  await chrome.storage.local.set({
    'fogar.settings': { mode: 'local', modelId: model, gpu: true, autoLoad: true, onboarded: true, cloud: { endpoint: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' }, grounding: { provider: 'none', apiKey: '', byDefault: true } },
    'fogar.layout': { version: 1, focus: false, widgets: [
      { id: 'agenda-1', type: 'agenda', config: { url: `http://127.0.0.1:${port}/agenda.ics` } },
      { id: 'weather-1', type: 'weather', config: { place: { name: 'Denver', region: 'Colorado', country: 'United States', lat: 39.7, lon: -104.9 }, unit: 'f', endpoint: `http://127.0.0.1:${port}/weather` } },
      { id: 'todos', type: 'todos', config: {} }, { id: 'reminders', type: 'reminders', config: {} },
      { id: 'links-1', type: 'links', config: { name: 'Links', links: [{ title: 'GitHub', url: 'https://github.com' }, { title: 'Hacker News', url: 'https://news.ycombinator.com' }, { title: 'Docs', url: 'https://developer.chrome.com' }, { title: 'Figma', url: 'https://figma.com' }] } },
      { id: 'notes-1', type: 'notes', config: { name: 'Notes', text: 'Thursday: send the deck before noon.\nAsk Priya about the venue deposit.' } },
    ] },
    'fogar.todos': [{ id: 'a', text: 'Reply to the accountant', done: false, createdAt: 1 }, { id: 'b', text: 'Book the dentist', done: false, createdAt: 2 }, { id: 'c', text: 'Renew the domain', done: true, createdAt: 3 }],
    'fogar.reminders': [{ id: 'r1', label: 'Stretch', when: Date.now() + 25 * 60e3, createdAt: 1 }, { id: 'r2', label: 'Call mom', when: new Date().setHours(18, 0, 0, 0) > Date.now() ? new Date().setHours(18, 0, 0, 0) : Date.now() + 86400e3, createdAt: 2 }],
  });
}, { port: mock.port, model });

// 1. an answer with a follow-up, real model
await page.goto(base);
await page.waitForFunction(() => document.body.dataset.status === 'ready', null, { timeout: 15 * 60 * 1000 });
await page.fill('#prompt', 'Explain what OPFS is in two sentences.');
await page.press('#prompt', 'Enter');
await waitDone();
await page.fill('#prompt', 'Now say it like a pirate, one sentence.');
await page.press('#prompt', 'Enter');
await waitDone();
await page.evaluate(() => window.scrollTo(0, 0));
await shot('01-answer');

// 2. a recipe with output
await page.goto(base);
await page.waitForFunction(() => document.body.dataset.status === 'ready', null, { timeout: 15 * 60 * 1000 });
await page.click('#recipe-chips .chip:has-text("Draft & rewrite")');
await page.fill('#recipe-panel textarea', 'hey cant make the 3pm today, thurs work instead? sorry for the short notice');
await page.selectOption('#recipe-panel select >> nth=0', 'Friendly');
await page.selectOption('#recipe-panel select >> nth=2', 'Chat message');
await page.click('#recipe-panel .primary');
await waitDone();
await page.evaluate(() => document.querySelector('.recipes').scrollIntoView({ block: 'start' }));
await page.evaluate(() => window.scrollBy(0, -40));
await shot('02-recipe');

// 3. widgets
await page.goto(base);
await page.waitForSelector('.widget[data-type="weather"] .temp');
await page.waitForSelector('.widget[data-type="agenda"] .event');
await page.evaluate(() => document.getElementById('corner').scrollIntoView({ block: 'start' }));
await page.evaluate(() => window.scrollBy(0, -24));
await shot('03-widgets');

// 4. settings: model tiers and the ledger
await page.evaluate(() => { document.getElementById('settings').open = true; document.getElementById('local-settings').scrollIntoView({ block: 'start' }); window.scrollBy(0, -24); });
await shot('04-settings');

// promo tile and marquee: rendered pages, screenshotted
const tile = (w, h, big) => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Source+Serif+4:opsz,wght@8..60,400&display=swap"><style>
  html,body{margin:0;width:${w}px;height:${h}px;background:#14100d;color:#efe6da;font-family:"Source Serif 4",Georgia,serif;overflow:hidden}
  .glow{position:absolute;left:50%;top:60%;width:${w * 0.9}px;height:${h}px;transform:translate(-50%,-30%);background:radial-gradient(ellipse at 50% 50%,rgba(255,106,43,.35),rgba(255,179,128,.08) 45%,transparent 70%);filter:blur(20px)}
  .in{position:absolute;inset:0;display:grid;align-content:center;justify-items:${big ? 'start' : 'center'};padding:${big ? '0 90px' : '0 28px'};gap:${big ? 18 : 10}px;text-align:${big ? 'left' : 'center'}}
  .brand{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;letter-spacing:-.03em;font-size:${big ? 96 : 54}px;line-height:1;display:flex;align-items:center;gap:${big ? 22 : 12}px}
  .dot{width:${big ? 30 : 16}px;height:${big ? 30 : 16}px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#ffb380,#ff6a2b 55%,#b23a12);box-shadow:0 0 ${big ? 60 : 30}px rgba(255,106,43,.6)}
  .tag{font-size:${big ? 30 : 17}px;color:#c9bba9;line-height:1.3;max-width:${big ? 720 : 380}px}
  .tag em{font-style:normal;color:#ff6a2b}
</style></head><body><div class="glow"></div><div class="in"><div class="brand"><span class="dot"></span>Fogar</div><div class="tag">A new tab that answers from a model in your browser. <em>Nothing leaves the room.</em></div></div></body></html>`;
for (const [name, w, h, big] of [['promo-440x280', 440, 280, false], ['marquee-1400x560', 1400, 560, true]]) {
  const p = await context.newPage({ viewport: { width: w, height: h } });
  await p.setContent(tile(w, h, big), { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.screenshot({ path: `store/${name}.png` });
  await p.close();
}
mock.server.close();
await context.close();
console.log('store assets written to store/');

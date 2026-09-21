// Model quality and speed check. Loads the built extension into a browser and runs a fixed prompt set per model.
// Usage: MODELS=qwen3.5-0.8b,qwen3.5-2b GPU=1 CHANNEL=chrome node scripts/eval-models.mjs
// CHANNEL=chrome uses the installed Google Chrome (real-world numbers); default is Playwright's Chromium.
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ext = resolve('.output/chrome-mv3');
const models = (process.env.MODELS || 'qwen3.5-0.8b,qwen3.5-2b').split(',');
const gpu = process.env.GPU === '0' ? '0' : '1';
const channel = process.env.CHANNEL || 'chromium';
const userDataDir = process.env.PROFILE || mkdtempSync(join(tmpdir(), 'fogar-eval-')); // reuse PROFILE= to keep downloads between runs
const context = await chromium.launchPersistentContext(userDataDir, {
  channel, headless: process.env.HEADED !== '1',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--enable-unsafe-webgpu'],
});
let sw = context.serviceWorkers()[0]; if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
const all = [];
for (const model of models) {
  const t0 = Date.now();
  await page.goto(`chrome-extension://${extId}/newtab.html?eval=1&model=${model}&gpu=${gpu}`);
  await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: 20 * 60 * 1000 });
  const out = JSON.parse(await page.evaluate(() => document.getElementById('eval-out').textContent));
  out.wallMs = Date.now() - t0; out.channel = channel;
  all.push(out);
  console.log(`\n=== ${model}  gpu=${gpu} (${out.cpuFallback ? 'fell back to CPU' : gpu === '1' ? 'WebGPU' : 'CPU'})  load ${out.loadMs} ms  wall ${out.wallMs} ms ===`);
  if (!out.loaded) { console.log('  LOAD FAILED:', out.error); continue; }
  for (const r of out.results) {
    console.log(`  [${r.name}] first ${r.firstTokenMs} ms · ${r.tokPerSec ?? '?'} tok/s · ${r.tokens} tok`);
    console.log('    ' + r.text.replace(/\n/g, '\n    '));
  }
}
if (errors.length) console.log('\nconsole errors:\n  ' + [...new Set(errors)].slice(0, 10).join('\n  '));
mkdirSync('.output/eval', { recursive: true });
const file = `.output/eval/${channel}-gpu${gpu}-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(all, null, 2));
console.log(`\nsaved ${file}`);
await context.close();

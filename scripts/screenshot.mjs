// Screenshots of the new tab in light and dark for a visual check. Output path via OUT (default ./.output/shots).
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ext = resolve('.output/chrome-mv3');
const out = process.env.OUT || resolve('.output/shots');
mkdirSync(out, { recursive: true });
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'fogar-shot-')), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let sw = context.serviceWorkers()[0]; if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const page = await context.newPage();
for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`chrome-extension://${extId}/newtab.html?e2e=1`);
  await page.evaluate(() => chrome.storage.local.clear()); // fresh profile state for each scheme
  await page.goto(`chrome-extension://${extId}/newtab.html`);
  await page.waitForSelector('#firstrun:not([hidden])');
  await page.screenshot({ path: join(out, `firstrun-${scheme}.png`) });
  await page.goto(`chrome-extension://${extId}/newtab.html?e2e=1`);
  await page.waitForSelector('#recipe-chips .chip');
  await page.fill('#todo-input', 'Ship Fogar'); await page.press('#todo-input', 'Enter');
  await page.fill('#reminder-input', 'stand up in 30 minutes'); await page.press('#reminder-input', 'Enter');
  await page.click('#reminder-confirm .primary');
  await page.click('#recipe-chips .chip');
  await page.waitForSelector('#recipe-panel:not([hidden])');
  await page.screenshot({ path: join(out, `home-${scheme}.png`), fullPage: true });
}
// Every curated accent in light and dark, a few with the other paper, heading, and density choices, so nothing
// a user can pick from Customize ships unreadable.
const ACCENTS = [['Ember', 40, 0.19], ['Moss', 145, 0.12], ['Ocean', 235, 0.14], ['Plum', 325, 0.14], ['Slate', 250, 0.05], ['Sand', 75, 0.09]];
for (const [name, hue, chroma] of ACCENTS) {
  for (const appearance of ['light', 'dark']) {
    const theme = { version: 1, appearance, hue, chroma, accentName: name, paper: name === 'Ocean' ? 'cool' : name === 'Slate' ? 'neutral' : 'warm', headings: name === 'Slate' ? 'sans' : 'serif', density: name === 'Sand' ? 'compact' : 'comfortable' };
    await page.goto(`chrome-extension://${extId}/newtab.html?e2e=1`);
    await page.evaluate((t) => chrome.storage.local.set({ 'fogar.theme': t }), theme);
    await page.goto(`chrome-extension://${extId}/newtab.html?e2e=1`);
    await page.waitForSelector('#customize-btn');
    await page.click('#customize-btn');
    await page.screenshot({ path: join(out, `theme-${name.toLowerCase()}-${appearance}.png`), clip: { x: 0, y: 0, width: 1280, height: 720 } });
  }
}
await context.close();
console.log(`screenshots in ${out}`);

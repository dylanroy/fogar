// Renders the Fogar mark to public/icon/{16,32,48,96,128}.png. WXT picks these up for the manifest automatically.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

// A flame on a warm square: the hearth. Kept to two colours so it reads at 16 px.
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#c2410c"/>
  <path fill="#fff7ed" d="M64 18c4 18 22 26 22 50a22 22 0 0 1-44 0c0-10 5-16 9-22 1 8 5 12 9 12 0-14-3-26 4-40z"/>
  <path fill="#c2410c" opacity=".55" d="M64 62c3 9 11 12 11 21a11 11 0 0 1-22 0c0-6 3-9 5-12 1 4 3 6 5 6 0-6-2-10 1-15z"/>
</svg>`;

mkdirSync('public/icon', { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of [16, 32, 48, 96, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg(size)}`);
  await page.screenshot({ path: `public/icon/${size}.png`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log('gen-icons: wrote public/icon/{16,32,48,96,128}.png');

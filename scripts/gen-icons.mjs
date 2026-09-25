// Renders the Fogar mark to public/icon/{16,32,48,96,128}.png (the extension; WXT picks these up for the manifest) and
// to web/icon/{180,192,512}.png plus a maskable 512 for the web app's home screen. The maskable one is the mark on a
// full square, kept inside the safe zone, because the phone cuts its own shape out of it.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

// A flame on a warm square: the hearth. Kept to two colours so it reads at 16 px.
const MARK = `<path fill="#fff7ed" d="M64 18c4 18 22 26 22 50a22 22 0 0 1-44 0c0-10 5-16 9-22 1 8 5 12 9 12 0-14-3-26 4-40z"/>
  <path fill="#c2410c" opacity=".55" d="M64 62c3 9 11 12 11 21a11 11 0 0 1-22 0c0-6 3-9 5-12 1 4 3 6 5 6 0-6-2-10 1-15z"/>`;
const svg = (size, maskable = false) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="${maskable ? 0 : 28}" fill="#c2410c"/>
  ${maskable ? `<g transform="translate(19.2 19.2) scale(0.7)">${MARK}</g>` : MARK}
</svg>`;

const targets = [
  ...[16, 32, 48, 96, 128].map((size) => ({ dir: 'public/icon', size, name: `${size}.png`, maskable: false })),
  ...[180, 192, 512].map((size) => ({ dir: 'web/icon', size, name: `${size}.png`, maskable: false })),
  { dir: 'web/icon', size: 512, name: '512-maskable.png', maskable: true },
];
mkdirSync('public/icon', { recursive: true }); mkdirSync('web/icon', { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg(t.size, t.maskable)}`);
  await page.screenshot({ path: `${t.dir}/${t.name}`, omitBackground: true, clip: { x: 0, y: 0, width: t.size, height: t.size } });
}
await browser.close();
console.log('gen-icons: wrote public/icon/{16,32,48,96,128}.png and web/icon/{180,192,512,512-maskable}.png');

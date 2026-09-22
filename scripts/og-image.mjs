// Social card for fogar.ai (1200x630), same mark and line as the store promo tiles. Writes site/og.jpg.
import { chromium } from 'playwright';

const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Source+Serif+4:opsz,wght@8..60,400&display=swap"><style>
  html,body{margin:0;width:1200px;height:630px;background:#14100d;color:#efe6da;font-family:"Source Serif 4",Georgia,serif;overflow:hidden}
  .glow{position:absolute;left:50%;top:60%;width:1080px;height:630px;transform:translate(-50%,-30%);background:radial-gradient(ellipse at 50% 50%,rgba(255,106,43,.35),rgba(255,179,128,.08) 45%,transparent 70%);filter:blur(20px)}
  .in{position:absolute;inset:0;display:grid;align-content:center;justify-items:start;padding:0 96px;gap:22px}
  .brand{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;letter-spacing:-.03em;font-size:104px;line-height:1;display:flex;align-items:center;gap:24px}
  .dot{width:32px;height:32px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#ffb380,#ff6a2b 55%,#b23a12);box-shadow:0 0 60px rgba(255,106,43,.6)}
  .tag{font-size:34px;color:#c9bba9;line-height:1.3;max-width:900px}
  .tag em{font-style:normal;color:#ff6a2b}
  .sub{font-family:"Bricolage Grotesque",sans-serif;font-size:20px;color:#9b8e80;letter-spacing:.02em}
</style></head><body><div class="glow"></div><div class="in"><div class="brand"><span class="dot"></span>Fogar</div><div class="tag">A new tab that answers from a model in your browser. <em>Nothing leaves the room.</em></div><div class="sub">Free · open source · Chrome</div></div></body></html>`;

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: 'site/og.jpg', type: 'jpeg', quality: 90 });
await browser.close();
console.log('og-image: wrote site/og.jpg');

// Featured image for blog post one (docs/blog-1-draft.md): the title beside a new tab page that answers, over the
// console line Manifest V3 printed first. 1200x630 at 2x, so it serves as the post's header and its social card.
// Same palette, type, and glow as scripts/og-image.mjs. Writes docs/blog-1-featured.png.
import { chromium } from 'playwright';

const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&family=Source+Serif+4:opsz,wght@8..60,400&family=IBM+Plex+Mono:wght@400;500&display=swap"><style>
  html,body{margin:0;width:1200px;height:630px;background:#14100d;color:#efe6da;font-family:"Source Serif 4",Georgia,serif;overflow:hidden}
  .glow{position:absolute;right:-120px;top:40px;width:900px;height:620px;background:radial-gradient(ellipse at 50% 50%,rgba(255,106,43,.30),rgba(255,179,128,.07) 45%,transparent 70%);filter:blur(24px)}
  .left{position:absolute;left:72px;top:0;bottom:0;width:520px;display:grid;align-content:center;gap:26px}
  .brand{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;letter-spacing:-.02em;font-size:30px;display:flex;align-items:center;gap:12px}
  .dot{width:14px;height:14px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#ffb380,#ff6a2b 55%,#b23a12);box-shadow:0 0 30px rgba(255,106,43,.6)}
  h1{margin:0;font-family:"Bricolage Grotesque",sans-serif;font-weight:800;font-variation-settings:"opsz" 96;letter-spacing:-.03em;font-size:60px;line-height:1}
  h1 em{font-style:normal;color:#ff6a2b}
  .by{font-family:"IBM Plex Mono",monospace;font-size:15px;color:#9b8e80;letter-spacing:.04em}
  .win{position:absolute;right:64px;top:86px;width:520px;border-radius:16px;background:#1d1712;border:1px solid #33291f;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,106,43,.06);overflow:hidden}
  .bar{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#26201a;border-bottom:1px solid #33291f}
  .bar i{width:11px;height:11px;border-radius:50%;background:#443728}
  .tab{margin-left:10px;padding:5px 14px;border-radius:8px 8px 0 0;background:#1d1712;font-family:"Bricolage Grotesque",sans-serif;font-size:13px;color:#c9bba9;display:flex;gap:8px;align-items:center}
  .tab .dot{width:8px;height:8px;box-shadow:none}
  .body{padding:22px 22px 18px;display:grid;gap:14px}
  .ask{border:1px solid #443728;border-radius:14px;padding:14px 16px;font-size:19px;color:#efe6da;display:flex;justify-content:space-between;align-items:center}
  .send{width:28px;height:28px;border-radius:50%;background:#ff6a2b;display:grid;place-items:center;color:#1a0e07;font-family:"Bricolage Grotesque";font-weight:800;font-size:16px}
  .ans{font-size:17px;line-height:1.5;color:#c9bba9}
  .ans b{color:#efe6da;font-weight:400}
  .cursor{display:inline-block;width:9px;height:18px;background:#ff6a2b;vertical-align:-3px;margin-left:2px}
  .stat{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:#9b8e80}
  .stat span{color:#ff6a2b}
  .console{position:absolute;right:30px;top:410px;width:560px;border-radius:12px;background:#0e0b09;border:1px solid #33291f;padding:14px 16px;font-family:"IBM Plex Mono",monospace;font-size:12.5px;line-height:1.65;box-shadow:0 20px 50px rgba(0,0,0,.6)}
  .err{color:#ff8a70}
  .err s{color:#9b8e80}
  .ok{color:#8fc59a}
  .dim{color:#6f6358}
</style></head><body>
<div class="glow"></div>
<div class="left">
  <div class="brand"><span class="dot"></span>Fogar</div>
  <h1>I put a language model inside a Chrome new tab page. <em>Here is what broke.</em></h1>
  <div class="by">dylanroy.com · Manifest V3 · wllama · WebGPU</div>
</div>
<div class="win">
  <div class="bar"><i></i><i></i><i></i><div class="tab"><span class="dot"></span>New Tab</div></div>
  <div class="body">
    <div class="ask">What is 18% of 240?<span class="send">↑</span></div>
    <div class="ans"><b>43.2.</b> Worked out on this page, not by the model: small models get arithmetic wrong, so it never reaches them</div>
    <div class="stat"><span>●</span> Ready · Qwen3.5 4B · on your GPU · 44 tok/s</div>
  </div>
</div>
<div class="console">
  <div class="err">✕ Refused to create a worker from '<s>blob:chrome-extension://…</s>'</div>
  <div class="dim">&nbsp;&nbsp;script-src 'self' 'wasm-unsafe-eval'</div>
  <div class="ok">✓ llama-worker.js · Multithread enabled: true, pthreadPoolSize: 8</div>
</div>
</body></html>`;

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: 'docs/blog-1-featured.png' });
await browser.close();
console.log('blog-image: wrote docs/blog-1-featured.png (2400x1260)');

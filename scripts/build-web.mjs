// Builds the web app into .output/web: the same page as the extension's new tab, through vite.web.config.ts, plus the
// web-only files in web/ (manifest, headers, service worker, home-screen icons). The service worker gets the list of
// built files to precache and a version derived from their contents, so a deploy that changes nothing installs nothing.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';

const OUT = '.output/web';
if (!existsSync('public/wllama/wllama.wasm') || !existsSync('public/tesseract/worker.min.js') || !existsSync('web/wllama/wllama-compat.wasm')) execSync('npm run gen', { stdio: 'inherit' });
// tsconfig.json extends the one WXT writes at install time; a fresh checkout that skipped postinstall has none yet.
if (!existsSync('.wxt/tsconfig.json')) execSync('npx wxt prepare', { stdio: 'inherit' });
execSync('npx vite build --config vite.web.config.ts', { stdio: 'inherit' });
cpSync('web', OUT, { recursive: true });

// Everything the page needs to open and answer offline. The OCR files (8 MB) and the compat model runtime (15 MB, Safari
// before 27) are left to their first use, and cached then.
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p); else files.push('/' + relative(OUT, p).split(sep).join('/'));
  }
})(OUT);
const skip = new Set(['/sw.js', '/_headers', '/index.html']);
const precache = ['/', ...files.filter((f) => !skip.has(f) && !f.startsWith('/tesseract/') && !/-compat(\.js|\.wasm|$)/.test(f)).sort()];
const hash = createHash('sha256');
for (const f of files) if (f !== '/sw.js') hash.update(f).update(readFileSync(join(OUT, f)));
hash.update(readFileSync('web/sw.js'));
const version = hash.digest('hex').slice(0, 12);
const template = readFileSync('web/sw.js', 'utf8');
if (!template.includes("'__VERSION__'") || !template.includes('__PRECACHE__')) throw new Error('web/sw.js lost its placeholders');
writeFileSync(join(OUT, 'sw.js'), template.replace("'__VERSION__'", JSON.stringify(version)).replace('__PRECACHE__', JSON.stringify(precache)));
const bytes = precache.filter((f) => f !== '/').reduce((n, f) => n + statSync(join(OUT, f)).size, 0);
console.log(`build-web: ${OUT} ready; ${precache.length} files precached (${(bytes / 1e6).toFixed(1)} MB), version ${version}`);

// Builds fogar.ai into site/ from its sources: the homepage body (site/page.html), one body per use-case page
// (site/src/*.html, one per use case), and site/src/shared.css for the widget mock-ups those pages draw.
//
// The homepage is the template. Its <style>, font links, nav, install section and footer are lifted out by
// <!-- @nav --> … <!-- @/nav --> markers and put into every page, so one edit reaches all of them. Each page gets its
// own <title>, description, canonical, Open Graph tags and JSON-LD; FAQ answers are read from the page's own <details>.
// Also writes sitemap.xml, robots.txt and icon.svg, and copies the current extension zip (from `npm run zip`) to
// site/fogar-chrome.zip, the Download button. Cloudflare serves site/tabs.html at /tabs (html_handling in
// wrangler.jsonc), so links and canonicals are extensionless.
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SITE = 'https://fogar.ai';
const STORE = 'https://chromewebstore.google.com/detail/fogar/cepnifpajfejaghhhaheadokfofcmoia';
const PAGES = [
  { path: '/', src: 'site/page.html', out: 'site/index.html', home: true },
  { path: '/tabs', src: 'site/src/tabs.html', out: 'site/tabs.html' },
  { path: '/bookmarks', src: 'site/src/bookmarks.html', out: 'site/bookmarks.html' },
  { path: '/write', src: 'site/src/write.html', out: 'site/write.html' },
  { path: '/today', src: 'site/src/today.html', out: 'site/today.html' },
  { path: '/voice', src: 'site/src/voice.html', out: 'site/voice.html' },
  { path: '/ask', src: 'site/src/ask.html', out: 'site/ask.html' },
  { path: '/search', src: 'site/src/search.html', out: 'site/search.html' },
  { path: '/files', src: 'site/src/files.html', out: 'site/files.html' },
  { path: '/notebook', src: 'site/src/notebook.html', out: 'site/notebook.html' },
  { path: '/draw', src: 'site/src/draw.html', out: 'site/draw.html' },
  { path: '/news', src: 'site/src/news.html', out: 'site/news.html' },
  { path: '/work', src: 'site/src/work.html', out: 'site/work.html' },
  { path: '/models', src: 'site/src/models.html', out: 'site/models.html' },
];
/**
 * Pages written ahead of the store: they describe features in a version still in review, and the Add to Chrome button
 * installs the one that is live. Held pages are not written, not in the sitemap, and every link to one is taken out
 * (menu entries and footer or homepage links removed, links in running text unwrapped). Empty this when the version
 * that carries them is live. FOGAR_SHOW_HELD=1 builds them anyway, for a local preview; never deploy that build.
 */
const HOLD = new Set(process.env.FOGAR_SHOW_HELD === '1' ? [] : [
  // v0.1.1: attachments, LLM Chat and cloud profiles, Canvas, Notebook and Post-its, Feed, Inbox and Jira
  '/ask', '/search', '/files', '/models', '/draw', '/notebook', '/news', '/work',
]);
const held = (path) => HOLD.has(path);

/** Take every link to a held page out of a built page. */
function hide(html) {
  if (!HOLD.size) return html;
  const paths = [...HOLD].map((p) => p.slice(1)).join('|');
  const link = `<a href="/(?:${paths})"[^>]*>`;
  return html
    .replace(new RegExp(`\\s*${link}<b>[\\s\\S]*?</a>`, 'g'), '') // menu entries
    .replace(/\s*<div class="menu-col">\s*<p class="menu-h">[^<]*<\/p>\s*<\/div>/g, '') // a menu column left empty
    .replace(new RegExp(` · ${link}[^<]*</a>`, 'g'), '') // footer list
    .replace(/<p class="cases-more">[\s\S]*?<\/p>/, (p) => { const q = p.replace(new RegExp(` ${link}[^<]*</a>`, 'g'), ''); return q.includes('<a ') ? q : ''; })
    .replace(new RegExp(`${link}([\\s\\S]*?)</a>`, 'g'), '$1'); // running text keeps its words
}

/** Hand-written pages that belong in the sitemap too. */
const ALSO = [{ path: '/privacy', src: 'site/privacy.html' }];

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const home = readFileSync('site/page.html', 'utf8');
const shared = readFileSync('site/src/shared.css', 'utf8').trim();
const today = new Date().toISOString().slice(0, 10);

/** Pull the head-only parts (title, description, font links, styles) out of a page body. */
function lift(source, name) {
  let body = source;
  const take = (re) => { const m = body.match(re); if (!m) return null; body = body.replace(m[0], ''); return m; };
  const title = take(/<title>([\s\S]*?)<\/title>\s*/)?.[1].trim();
  const description = take(/<meta name="description" content="([\s\S]*?)" \/>\s*/)?.[1];
  const og = take(/<meta property="og:description" content="([\s\S]*?)" \/>\s*/)?.[1];
  if (!title || !description) throw new Error(`${name}: every page needs a <title> and a <meta name="description">`);
  const links = []; const styles = [];
  for (let m; (m = take(/<link rel="(?:preconnect|stylesheet)"[^>]*\/>\s*/));) links.push(m[0].trim());
  for (let m; (m = take(/<style>[\s\S]*?<\/style>\s*/));) styles.push(m[0].trim());
  return { title, description, og: og ?? description, links, styles, body: body.trim() };
}

/** A block the homepage shares, by its marker comments. */
function partial(name) {
  const m = home.match(new RegExp(`<!-- @${name} -->\\s*([\\s\\S]*?)\\s*<!-- @/${name} -->`));
  if (!m) throw new Error(`site/page.html: no <!-- @${name} --> … <!-- @/${name} --> block to share`);
  return m[1];
}

/** A shared block on a page that is not the homepage: in-page anchors point back at the homepage, the brand goes home, and the menu marks the page you are on. */
function adapt(html, page, name) {
  if (page.home) return html;
  let out = html.replace(/href="#(?!top")/g, 'href="/#');
  if (name === 'nav') out = out.replace(/href="#top"/g, 'href="/"');
  return out.replace(new RegExp(`href="${page.path}"`, 'g'), `href="${page.path}" aria-current="page"`);
}

const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/&(?!(amp|lt|gt|quot|#\d+);)/g, '&amp;').replace(/"/g, '&quot;');

/** The questions and answers in a page's FAQ, for structured data that cannot drift from the page. */
function faq(body) {
  const block = body.match(/<div class="faq">([\s\S]*?)<\/section>/)?.[1] ?? '';
  return [...block.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)].map((m) => ({ q: text(m[1]), a: text(m[2]) }));
}

const SITE_ID = `${SITE}/#website`;
const APP_ID = `${SITE}/#app`;
function jsonld(page, meta) {
  const url = `${SITE}${page.path}`;
  const app = { '@type': 'SoftwareApplication', '@id': APP_ID, name: 'Fogar', url: `${SITE}/` };
  const graph = [{ '@type': 'WebSite', '@id': SITE_ID, name: 'Fogar', url: `${SITE}/` }];
  if (page.home) {
    graph.push({
      ...app, description: meta.description, applicationCategory: 'BrowserApplication', operatingSystem: 'Chrome', softwareVersion: version,
      isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      author: { '@type': 'Person', name: 'Dylan Roy', url: 'https://dylanroy.com' },
      image: `${SITE}/og.jpg`, downloadUrl: STORE, installUrl: STORE, license: 'https://github.com/dylanroy/fogar/blob/main/LICENSE',
    });
  } else {
    graph.push({ '@type': 'WebPage', '@id': url, url, name: meta.title, description: meta.description, isPartOf: { '@id': SITE_ID }, about: app });
  }
  const qa = faq(meta.body);
  if (qa.length) graph.push({ '@type': 'FAQPage', '@id': `${url}#faq`, mainEntity: qa.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}

function head(page, meta, links, styles) {
  const url = `${SITE}${page.path}`;
  return [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${meta.title}</title>`,
    `<meta name="description" content="${esc(meta.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    '<meta property="og:site_name" content="Fogar" />',
    `<meta property="og:title" content="${esc(meta.title)}" />`,
    `<meta property="og:description" content="${esc(meta.og)}" />`,
    `<meta property="og:url" content="${url}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:image" content="${SITE}/og.jpg" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:image" content="${SITE}/og.jpg" />`,
    '<meta name="theme-color" content="#14100d" />',
    '<link rel="icon" href="/icon.svg" type="image/svg+xml" />',
    ...links,
    ...styles,
    `<script type="application/ld+json">${jsonld(page, meta)}</script>`,
  ].join('\n');
}

const homeMeta = lift(home, 'site/page.html');
for (const page of PAGES) {
  if (held(page.path)) { rmSync(page.out, { force: true }); console.log(`build-site: ${page.out} held (see HOLD)`); continue; }
  const meta = page.home ? homeMeta : lift(readFileSync(page.src, 'utf8'), page.src);
  const body = hide(meta.body
    .replace(/<!-- @include (\w+) -->/g, (_, name) => adapt(partial(name), page, name))
    .replace(/[ \t]*<!-- @\/?\w+ -->\n?/g, '')); // the markers have done their job
  const styles = page.home ? homeMeta.styles : [...homeMeta.styles, `<style>\n${shared}\n</style>`, ...meta.styles];
  const html = `<!doctype html>\n<html lang="en">\n<head>\n${head(page, meta, homeMeta.links, styles)}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
  writeFileSync(page.out, html);
  console.log(`build-site: ${page.out} (${meta.title})`);
}

/** The newest commit date among the files a page is built from; today if any of them has uncommitted changes. */
function lastmod(...files) {
  const dates = files.map((f) => {
    try {
      if (execSync(`git status --porcelain -- "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) return today;
      return execSync(`git log -1 --format=%cs -- "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || today;
    } catch { return today; }
  });
  return dates.sort().at(-1);
}
const urls = [
  ...PAGES.filter((p) => !held(p.path)).map((p) => ({ loc: `${SITE}${p.path}`, lastmod: lastmod(p.src, 'site/page.html', 'site/src/shared.css') })),
  ...ALSO.map((p) => ({ loc: `${SITE}${p.path}`, lastmod: lastmod(p.src) })),
];
writeFileSync('site/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}\n</urlset>\n`);
writeFileSync('site/robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
writeFileSync('site/icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#c2410c"/><path fill="#fff7ed" d="M64 18c4 18 22 26 22 50a22 22 0 0 1-44 0c0-10 5-16 9-22 1 8 5 12 9 12 0-14-3-26 4-40z"/><path fill="#c2410c" opacity=".55" d="M64 62c3 9 11 12 11 21a11 11 0 0 1-22 0c0-6 3-9 5-12 1 4 3 6 5 6 0-6-2-10 1-15z"/></svg>\n`);
console.log(`build-site: sitemap.xml (${urls.length} urls), robots.txt, icon.svg`);

const zip = `.output/fogar-${version}-chrome.zip`;
if (existsSync(zip)) {
  copyFileSync(zip, 'site/fogar-chrome.zip');
  const mb = (statSync(zip).size / 1e6).toFixed(1);
  console.log(`build-site: copied ${zip} to site/fogar-chrome.zip (${mb} MB; the install section states the size and version)`);
} else {
  console.warn(`build-site: ${zip} not found; run \`npm run zip\` first or the Download button will 404 on deploy`);
}

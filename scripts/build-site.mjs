// Wraps site/page.html (the page body, shared with the Artifact preview) into a deployable site/index.html.
import { readFileSync, writeFileSync } from 'node:fs';

const body = readFileSync('site/page.html', 'utf8');
const title = body.match(/<title>(.*?)<\/title>/)?.[1] ?? 'Fogar';
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="A new tab for Chrome that answers from a model running inside your browser. Nothing leaves the room." />
<meta property="og:url" content="https://fogar.ai/" />
<meta name="theme-color" content="#14100d" />
<link rel="canonical" href="https://fogar.ai/" />
<link rel="icon" href="icon.svg" type="image/svg+xml" />
</head>
<body>
${body.replace(/^<title>.*?<\/title>\n/, `<title>${title}</title>\n`)}
</body>
</html>
`;
writeFileSync('site/index.html', html);
writeFileSync('site/icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#c2410c"/><path fill="#fff7ed" d="M64 18c4 18 22 26 22 50a22 22 0 0 1-44 0c0-10 5-16 9-22 1 8 5 12 9 12 0-14-3-26 4-40z"/><path fill="#c2410c" opacity=".55" d="M64 62c3 9 11 12 11 21a11 11 0 0 1-22 0c0-6 3-9 5-12 1 4 3 6 5 6 0-6-2-10 1-15z"/></svg>\n`);
console.log('build-site: wrote site/index.html and site/icon.svg');

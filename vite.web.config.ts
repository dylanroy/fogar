import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { wllamaMv3 } from './lib/vite-plugin-wllama-mv3.ts';

// The web app: the same page as the extension's new tab (entrypoints/newtab), built by plain Vite for app.fogar.ai.
// `wxt/browser` becomes lib/web/browser-shim.ts, so no page code changes; the wllama plugin is the same one, and its
// worker rewrite already falls back to root-relative paths when there is no extension runtime. scripts/build-web.mjs
// runs this, then adds the web-only files from web/ (manifest, headers, service worker, home-screen icons).
const root = fileURLToPath(new URL('.', import.meta.url));

/** The head of the same page, dressed for the web: a name, the manifest, home-screen tags, and the service worker. */
function webHead(): Plugin {
  return {
    name: 'fogar:web-head',
    transformIndexHtml(html) {
      const out = html
        .replace('<title>New Tab</title>', '<title>Fogar</title>')
        .replace('<meta name="viewport" content="width=device-width, initial-scale=1.0" />', '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />')
        .replace('</head>', [
          '<link rel="manifest" href="/manifest.webmanifest" />',
          '<link rel="icon" href="/icon/32.png" sizes="32x32" />',
          '<link rel="apple-touch-icon" href="/icon/180.png" />',
          '<meta name="theme-color" content="#f8f2eb" media="(prefers-color-scheme: light)" />',
          '<meta name="theme-color" content="#100d08" media="(prefers-color-scheme: dark)" />',
          '<meta name="mobile-web-app-capable" content="yes" />',
          '<meta name="apple-mobile-web-app-capable" content="yes" />',
          '<meta name="apple-mobile-web-app-title" content="Fogar" />',
          '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
          '<script src="/register-sw.js" defer></script>',
          '</head>',
        ].join('\n    '));
      if (out === html || !out.includes('<title>Fogar</title>')) throw new Error('vite.web.config: entrypoints/newtab/index.html changed; update the head rewrite');
      return out;
    },
  };
}

export default defineConfig({
  root: 'entrypoints/newtab',
  publicDir: `${root}public`,
  base: '/',
  resolve: { alias: { 'wxt/browser': `${root}lib/web/browser-shim.ts`, '@': root.replace(/\/$/, '') } },
  plugins: [wllamaMv3(), webHead()],
  build: { outDir: `${root}.output/web`, emptyOutDir: true, sourcemap: false },
});

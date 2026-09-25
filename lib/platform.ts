/**
 * Where the page is running. The same source builds as the Chrome extension (entrypoints/newtab through WXT) and as
 * the web app at app.fogar.ai (vite.web.config.ts, with `wxt/browser` aliased to lib/web/browser-shim.ts). A few
 * things differ by platform: widgets that need extension APIs or cross-origin fetches a web page cannot make, where
 * reminders fire, and the words that name the host. Everything else is shared.
 */
export const isWeb = (): boolean => typeof (globalThis as any).chrome?.runtime?.getURL !== 'function';

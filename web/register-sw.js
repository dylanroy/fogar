// Registers the service worker that keeps the web app working with no connection, and asks the browser to keep this
// origin's storage: a downloaded model is hundreds of megabytes, and an installed app should not lose it under pressure.
(function () {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(function (err) { console.warn('[fogar] service worker registration failed', err); });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { /* best effort */ });
})();

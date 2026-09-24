// Runs synchronously in <head>, before the first paint, so the page never flashes the default theme or layout.
// It only reads what lib/theme.ts and lib/layout.ts mirrored into localStorage; chrome.storage stays the source of truth.
(function () {
  try {
    var root = document.documentElement;
    var t = JSON.parse(localStorage.getItem('fogar.theme') || 'null');
    if (t) {
      if (t.appearance === 'light' || t.appearance === 'dark') root.setAttribute('data-theme', t.appearance);
      var papers = { warm: [75, 0.012], neutral: [0, 0], cool: [250, 0.01] };
      var p = papers[t.paper] || papers.warm;
      root.style.setProperty('--h', String(t.hue)); root.style.setProperty('--c', String(t.chroma));
      root.style.setProperty('--ph', String(p[0])); root.style.setProperty('--pc', String(p[1]));
      root.setAttribute('data-headings', t.headings || 'serif'); root.setAttribute('data-density', t.density || 'comfortable');
    }
    var l = JSON.parse(localStorage.getItem('fogar.layout') || 'null');
    if (l) {
      root.setAttribute('data-ask', l.ask || 'top'); root.setAttribute('data-arrangement', l.arrangement || 'stack');
      root.setAttribute('data-columns', String(l.columns || 'auto')); root.setAttribute('data-width', l.width || 'normal'); root.setAttribute('data-recipes', l.showRecipes === false ? 'hidden' : 'shown');
      if (l.focus) root.classList.add('focus');
    }
  } catch (e) { /* first run, or storage blocked: the defaults in the stylesheet apply */ }
})();

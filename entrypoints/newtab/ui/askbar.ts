import type { App } from '../app';
import { $, clear, debounce, el } from '@/lib/dom';
import { browser } from 'wxt/browser';
import { bookmarksAvailable, removeBookmark, searchBookmarks } from '@/lib/bookmarks';

const SEARCH_URL = 'https://duckduckgo.com/?q=';

export function initAskBar(app: App): void {
  const prompt = $<HTMLTextAreaElement>('prompt');
  const ground = $<HTMLInputElement>('ground');
  const hits = $('bookmark-hits');

  ground.checked = app.settings.grounding.byDefault;

  const webSearch = (q: string) => { location.href = SEARCH_URL + encodeURIComponent(q); };

  $('ask-form').onsubmit = (e) => {
    e.preventDefault();
    const q = prompt.value.trim();
    if (!q) return;
    hits.hidden = true;
    // Before a model is ready the box still does something useful: a plain web search.
    if (!app.isReady() && !app.isBusy()) webSearch(q);
    else void app.askQuestion(q, ground.checked && !$('ground-toggle').hidden);
  };
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('ask-form').dispatchEvent(new Event('submit')); }
    if (e.key === 'Escape') hits.hidden = true;
  });
  $('web-search').onclick = (e) => { e.preventDefault(); if (prompt.value.trim()) webSearch(prompt.value.trim()); };
  $('stop-btn').onclick = () => app.stop();
  $('copy-btn').onclick = async () => {
    await navigator.clipboard.writeText($('answer').textContent ?? '');
    app.toast('Copied');
  };

  // Bookmark search as you type. Local, instant, and the reason the box says "or find a bookmark".
  if (bookmarksAvailable()) {
    const render = async (q: string) => {
      const found = await searchBookmarks(q);
      clear(hits);
      hits.hidden = found.length === 0;
      for (const b of found) {
        let host = ''; try { host = new URL(b.url).host.replace(/^www\./, ''); } catch { /* skip */ }
        const row = el('a', { class: 'hit', href: b.url },
          el('img', { src: browser.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(b.url)}&size=32` as any), alt: '' }),
          el('span', { class: 't' }, b.title),
          el('span', { class: 'h' }, host),
          el('button', {
            class: 'x', type: 'button', title: 'Remove bookmark',
            onclick: async (ev: MouseEvent) => {
              ev.preventDefault(); ev.stopPropagation();
              if (!confirm(`Remove bookmark “${b.title}”?`)) return;
              await removeBookmark(b.id);
              app.toast('Bookmark removed');
              void render(prompt.value);
            },
          }, '×'),
        );
        hits.append(row);
      }
    };
    prompt.addEventListener('input', debounce(() => void render(prompt.value), 120));
    document.addEventListener('click', (e) => { if (!hits.contains(e.target as Node) && e.target !== prompt) hits.hidden = true; });
  }
}

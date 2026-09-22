import type { App } from '../app';
import { $, clear, debounce, el } from '@/lib/dom';
import { browser } from 'wxt/browser';
import { bookmarksAvailable, removeBookmark, searchBookmarks } from '@/lib/bookmarks';
import { tryCalculate } from '@/lib/calc';
import type { RecipesUI } from './recipes';
import type { TodosUI } from './todos';
import type { RemindersUI } from './reminders';

export interface AskBarDeps { todos: TodosUI; reminders: RemindersUI; recipes: RecipesUI }

const SEARCH_URL = 'https://duckduckgo.com/?q=';
const URL_LIKE = /^(https?:\/\/)?(localhost|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,63})(:\d+)?(\/\S*)?$/i;
const SEARCH_PREFIX = /^(\?|\/s\s+|search(?:\s+for)?\s+)/i;
const REMIND = /^(\/remind\b|remind(?:er)?\b)/i;
const TODO = [/^(?:\/todo|todo|to-do|task)s?\s*[:\-]?\s+(.+)$/i, /^add (?:a |an )?(?:todo|task)\b[:\s]*(.+)$/i];

/**
 * One box, several outcomes, in this order: a URL opens, a "?" prefix searches, "remind me…" sets a reminder,
 * "todo: …" adds a todo, arithmetic is computed, bookmark questions go to the finder, everything else to the model.
 * Cmd/Ctrl+Enter always searches the web.
 */
export function initAskBar(app: App, deps: AskBarDeps): void {
  const prompt = $<HTMLTextAreaElement>('prompt');
  const ground = $<HTMLInputElement>('ground');
  const hits = $('bookmark-hits');
  ground.checked = app.settings.grounding.byDefault;

  const webSearch = (q: string) => { location.href = SEARCH_URL + encodeURIComponent(q); };
  let forceSearch = false;

  // Things to try, shown until the first question. They teach what the box is for: writing tasks, not trivia.
  const examples = $('examples');
  const refreshExamples = () => { examples.hidden = prompt.value.length > 0 || document.querySelector('#thread .answer-card') !== null; };
  const EXAMPLES: Array<[string, () => void]> = [
    ['✍️ Rewrite my draft', () => void deps.recipes.open('rewrite')],
    ['⏰ Remind me to stretch in 20 minutes', () => { prompt.value = 'remind me to stretch in 20 minutes'; submit(); }],
    ['🧮 18% of 240', () => { prompt.value = '18% of 240'; submit(); }],
    ['🔖 Find bookmarks about cooking', () => { prompt.value = 'find bookmarks about cooking'; prompt.focus(); prompt.setSelectionRange(prompt.value.length, prompt.value.length); }],
  ];
  for (const [label, run] of EXAMPLES) examples.append(el('button', { class: 'example', type: 'button', onclick: run }, label));
  prompt.addEventListener('input', refreshExamples);
  refreshExamples();

  const submit = () => {
    const q = prompt.value.trim();
    if (!q) return;
    hits.hidden = true;
    if (forceSearch) { forceSearch = false; webSearch(q); return; }
    if (!/\s/.test(q) && URL_LIKE.test(q) && /\.|localhost/.test(q)) { location.href = /^https?:\/\//i.test(q) ? q : `https://${q}`; return; }
    const sp = q.match(SEARCH_PREFIX);
    if (sp) { webSearch(q.slice(sp[0].length).trim() || q); return; }
    if (REMIND.test(q)) { deps.reminders.capture(q); prompt.value = ''; return; }
    for (const re of TODO) {
      const m = q.match(re);
      if (m) { void deps.todos.add(m[1]!.trim()).then(() => app.toast('Added to todos')); prompt.value = ''; return; }
    }
    const calc = tryCalculate(q);
    if (calc) { app.showCalculation(q, calc.display, calc.expression); prompt.value = ''; refreshExamples(); return; }
    // Before a model is ready the box still does something useful: a plain web search.
    if (!app.isReady() && !app.isBusy()) { webSearch(q); return; }
    void app.askQuestion(q, ground.checked && !$('ground-toggle').hidden);
    prompt.value = ''; refreshExamples();
  };

  $('ask-form').onsubmit = (e) => { e.preventDefault(); submit(); };
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); forceSearch = e.metaKey || e.ctrlKey; submit(); }
    if (e.key === 'Escape') hits.hidden = true;
  });
  $('web-search').onclick = (e) => { e.preventDefault(); if (prompt.value.trim()) webSearch(prompt.value.trim()); };
  $('stop-btn').onclick = () => app.stop();

  // Bookmark search as you type. Local, instant, and the reason the box says "or find a bookmark".
  if (bookmarksAvailable()) {
    const render = async (q: string) => {
      const found = await searchBookmarks(q);
      clear(hits);
      hits.hidden = found.length === 0;
      for (const b of found) {
        let host = ''; try { host = new URL(b.url).host.replace(/^www\./, ''); } catch { /* skip */ }
        const row = el('a', { class: 'hit', href: b.url, title: b.url },
          el('img', { src: browser.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(b.url)}&size=32` as any), alt: '' }),
          el('span', { class: 't' }, b.title),
          el('span', { class: 'h' }, b.path ? `${b.path} · ${host}` : host),
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

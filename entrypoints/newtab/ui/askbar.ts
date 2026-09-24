import type { App } from '../app';
import { $, clear, debounce, el } from '@/lib/dom';
import { browser } from 'wxt/browser';
import { bookmarksAvailable, removeBookmark, searchBookmarks } from '@/lib/bookmarks';
import { activateTab, hasTabsPermission, hostOf, openWindows, searchOpenTabs, searchSavedTabs, withoutOpen } from '@/lib/sessions';
import { tryCalculate } from '@/lib/calc';
import { LOCAL_BUDGET_WORDS, describeAttachment, fmt, type Attachment } from '@/lib/attachments';
import { hasFiles, readFiles } from './attach';
import type { RecipesUI } from './recipes';
import type { TodosUI } from './todos';
import type { RemindersUI } from './reminders';

export interface AskBarDeps { todos: TodosUI; reminders: RemindersUI; recipes: RecipesUI }

const SEARCH_URL = 'https://duckduckgo.com/?q=';
const URL_LIKE = /^(https?:\/\/)?(localhost|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,63})(:\d+)?(\/\S*)?$/i;
const SEARCH_PREFIX = /^(\?|\/s\s+|search(?:\s+for)?\s+)/i;
const REMIND = /^(\/remind\b|remind(?:er)?\b)/i;
const TODO = [/^(?:\/todo|todo|to-do|task)s?\s*[:\-]?\s+(.+)$/i, /^add (?:a |an )?(?:todo|task)\b[:\s]*(.+)$/i];

// Tests, screenshots, and the eval harness get the same first screen every time; people get a fresh draw per tab.
const FIXED = /[?&](e2e|smoke|eval)=1/.test(location.search);
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

/**
 * The placeholder is one quoted example, the shape of a request that goes well, not a list of what the box can
 * do. Writing tasks lead because that is what a small model is good at; the last two teach the routed forms.
 */
const PLACEHOLDERS = [
  'e.g. "Write a two-line thank-you note to the neighbor who fed the cat"',
  'e.g. "Explain compound interest to a ten-year-old"',
  'e.g. "Three subject lines for a newsletter about garden tools"',
  'e.g. "Draft a polite no to a meeting invite"',
  'e.g. "remind me to stretch in 20 minutes"',
  'e.g. "todo: renew the domain"',
];
const FILE_PLACEHOLDER = 'Ask about the file, e.g. "What is the total due, and by when?"';

interface Example { label: string; run: () => void; when?: () => boolean | Promise<boolean> }

const shuffle = <T>(list: T[]): T[] => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
};

/**
 * One box, several outcomes, in this order: a URL opens, a "?" prefix searches, "remind me…" sets a reminder,
 * "todo: …" adds a todo, arithmetic is computed, bookmark questions go to the finder, everything else to the model,
 * with any attached files in front of it. Cmd/Ctrl+Enter always searches the web.
 */
export function initAskBar(app: App, deps: AskBarDeps): void {
  const prompt = $<HTMLTextAreaElement>('prompt');
  const ground = $<HTMLInputElement>('ground');
  const groundToggle = $('ground-toggle');
  const groundTitle = groundToggle.title;
  const hits = $('bookmark-hits');
  const frame = $('askframe');
  const examples = $('examples');
  const help = $('help-card');
  ground.checked = app.settings.grounding.byDefault;

  // The box grows with what is typed, up to under half the window; the corner where a drag handle would sit now
  // holds the send button.
  const grow = () => { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, Math.round(window.innerHeight * 0.45))}px`; };
  prompt.addEventListener('input', grow);
  const setPrompt = (v: string) => { prompt.value = v; prompt.dispatchEvent(new Event('input', { bubbles: true })); };
  const reset = () => { prompt.value = ''; prompt.style.height = ''; refreshExamples(); };

  const webSearch = (q: string) => { location.href = SEARCH_URL + encodeURIComponent(q); };
  let forceSearch = false;

  // ---- attachments: read here, kept in memory for this tab's conversation, never stored ----
  const attachments: Attachment[] = [];
  const attList = $('attachments');
  const attInput = $<HTMLInputElement>('attach-input');
  const basePlaceholder = PLACEHOLDERS[FIXED ? 0 : Math.floor(Math.random() * PLACEHOLDERS.length)]!;
  const renderAttachments = () => {
    clear(attList);
    attList.hidden = attachments.length === 0;
    prompt.placeholder = attachments.length ? FILE_PLACEHOLDER : basePlaceholder;
    // A question about a file is answered from the file. Sent to the web as well, "bullets from the document"
    // came back with Tupac Shakur; so the toggle rests while a file is attached, and "Dig deeper" on the answer
    // still offers the search for the questions that want both.
    ground.disabled = attachments.length > 0;
    groundToggle.title = attachments.length ? 'Off while a file is attached: the question is about the file. Dig deeper on the answer can add web results.' : groundTitle;
    for (const a of attachments) {
      attList.append(el('span', { class: 'attachment', title: `${a.name} · ${describeAttachment(a)}` },
        el('span', { class: 'name' }, a.name),
        el('span', { class: 'meta' }, `· ${describeAttachment(a)}`),
        el('button', { class: 'x', type: 'button', title: 'Remove', 'aria-label': `Remove ${a.name}`, onclick: () => { attachments.splice(attachments.indexOf(a), 1); renderAttachments(); } } as any, '×')));
    }
  };
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const busy = el('span', { class: 'attachment busy' }, `Reading ${files.length === 1 ? files[0]!.name : `${files.length} files`}…`);
    attList.hidden = false; attList.append(busy);
    await readFiles(app, files, attachments);
    busy.remove(); renderAttachments();
    if (attachments.length) { void app.ensureModel(); prompt.focus(); }
  };
  $('attach-btn').onclick = () => attInput.click();
  attInput.onchange = () => { void addFiles(Array.from(attInput.files ?? [])); attInput.value = ''; };
  prompt.addEventListener('paste', (e) => { const files = e.clipboardData?.files; if (files?.length) { e.preventDefault(); void addFiles(Array.from(files)); } });
  // A file dropped anywhere on the page attaches to the question. Recipe fields take their own drops first.
  document.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); frame.classList.add('drop'); });
  document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) frame.classList.remove('drop'); });
  document.addEventListener('drop', (e) => {
    frame.classList.remove('drop');
    if (!hasFiles(e)) return;
    e.preventDefault();
    void addFiles(Array.from(e.dataTransfer!.files));
    frame.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  document.addEventListener('fogar:conversation-cleared', () => { attachments.length = 0; renderAttachments(); });
  renderAttachments();

  // ---- things to try: a rotating map of what the box does, shown until the first question ----
  const fillAndFocus = (v: string) => { setPrompt(v); prompt.focus(); prompt.setSelectionRange(v.length, v.length); };
  const submitText = (v: string) => { setPrompt(v); submit(); };
  const modelReady = () => app.canAnswer();
  // A word from a tab that is open right now goes in the box, so the hit list shows the switch for real.
  const showAnOpenTab = async () => {
    const { windows } = await openWindows();
    const tabs = windows.flatMap((w) => w.tabs.map((t) => ({ ...t, current: w.current })));
    const pick = tabs.find((t) => !t.current) ?? tabs.find((t) => !t.active) ?? tabs[0];
    const word = pick?.title.split(/[\s|·•–—:/-]+/).find((w) => w.length > 3) ?? '';
    fillAndFocus(word);
  };
  const POOL: Example[] = [
    { label: '✍️ A thank-you note to a neighbor', run: () => submitText('Write a two-line thank-you note to a neighbor who watered my plants while I was away.'), when: modelReady },
    { label: '💡 Compound interest, for a ten-year-old', run: () => submitText('Explain compound interest to a ten-year-old, in three sentences.'), when: modelReady },
    { label: '📧 A polite no to a meeting invite', run: () => submitText('Draft a polite two-sentence reply declining a meeting invite for Thursday afternoon.'), when: modelReady },
    { label: '⏰ Remind me to stretch in 20 minutes', run: () => submitText('remind me to stretch in 20 minutes') },
    { label: '☑️ todo: renew the domain', run: () => submitText('todo: renew the domain') },
    { label: '🧮 18% of 240', run: () => submitText('18% of 240') },
    { label: '🔎 Start with ? to search the web', run: () => fillAndFocus('? ') },
    { label: '📎 Drop a file to ask about it', run: () => attInput.click() },
    { label: '🔖 Find bookmarks about cooking', run: () => fillAndFocus('find bookmarks about cooking'), when: () => bookmarksAvailable() },
    { label: '🗂️ Switch to an open tab by name', run: () => void showAnOpenTab(), when: hasTabsPermission },
  ];
  const order = FIXED ? POOL : shuffle(POOL);
  let tabsOk = false;
  async function renderExamples() {
    tabsOk = await hasTabsPermission();
    const chosen: Example[] = [];
    for (const ex of order) {
      if (chosen.length >= 4) break;
      if (ex.when && !(await ex.when())) continue;
      chosen.push(ex);
    }
    clear(examples);
    for (const ex of chosen) examples.append(el('button', { class: 'example', type: 'button', onclick: ex.run }, ex.label));
    examples.append(el('button', { class: 'example help-chip', type: 'button', 'aria-expanded': String(!help.hidden), onclick: () => (help.hidden ? showHelp() : hideHelp()) } as any, '❓ What can I type here?'));
  }
  const refreshExamples = () => { examples.hidden = prompt.value.length > 0 || document.querySelector('#thread .answer-card') !== null; };
  prompt.addEventListener('input', refreshExamples);
  app.onReadyChange(() => void renderExamples());
  void renderExamples();
  refreshExamples();

  // ---- help: the routing rules as a static card, never a model answer; a small model would invent features ----
  function hideHelp() { help.hidden = true; examples.querySelector('.help-chip')?.setAttribute('aria-expanded', 'false'); }
  function showHelp() {
    clear(help);
    const row = (k: string, ...d: Array<string | Node>) => [el('dt', {}, k), el('dd', {}, ...d)];
    const b = (s: string) => el('b', {}, s);
    help.append(
      el('div', { class: 'help-head' }, el('h3', {}, 'One box, several outcomes'), el('button', { class: 'ghost small', type: 'button', onclick: hideHelp }, 'Got it')),
      el('dl', {},
        ...row('a web address', b('opens it'), '.'),
        ...row('? weather denver', b('searches the web'), `. ${MOD}+Enter searches whatever you typed.`),
        ...row('remind me to call the dentist tomorrow at 9', b('sets a reminder'), ', once you confirm the time.'),
        ...row('todo: renew the domain', b('adds a todo'), '.'),
        ...row('18% of 240', b('is calculated here'), ', no model involved.'),
        ...row('a few letters', b(tabsOk ? 'finds bookmarks and open tabs' : 'finds bookmarks'), ' as you type.', tabsOk ? '' : ' Add the Sessions widget and it finds open tabs too.'),
        ...row('find bookmarks about cooking', b('has the model sort your bookmarks'), '.'),
        ...row('+ or a dropped file', b('attaches a PDF, Word, or text file'), `. Read here, never uploaded. On this device the model gets about the first ${fmt(LOCAL_BUDGET_WORDS)} words and keeps them for follow-ups. Questions about it skip the web search.`),
        ...row('anything else', b('goes to the model'), '. Shift+Enter for a new line.'),
        ...row('right-click on any page', b('“Ask Fogar about …”'), ' carries that page along.'),
      ));
    help.hidden = false;
    examples.querySelector('.help-chip')?.setAttribute('aria-expanded', 'true');
  }

  // Typing something that reads like a question is the signal to bring the cached model up. A bare URL or a
  // search prefix is not, so the tabs people open just to navigate stay cheap.
  prompt.addEventListener('input', () => {
    const v = prompt.value.trim();
    if (v.length >= 3 && /\s/.test(v) && !SEARCH_PREFIX.test(v)) void app.ensureModel();
  });

  const submit = () => {
    const q = prompt.value.trim();
    if (!q) return;
    hits.hidden = true;
    if (forceSearch) { forceSearch = false; webSearch(q); return; }
    if (!/\s/.test(q) && URL_LIKE.test(q) && /\.|localhost/.test(q)) { location.href = /^https?:\/\//i.test(q) ? q : `https://${q}`; return; }
    const sp = q.match(SEARCH_PREFIX);
    if (sp) { webSearch(q.slice(sp[0].length).trim() || q); return; }
    if (REMIND.test(q)) { deps.reminders.capture(q); reset(); return; }
    for (const re of TODO) {
      const m = q.match(re);
      if (m) { void deps.todos.add(m[1]!.trim()).then(() => app.toast('Added to todos')); reset(); return; }
    }
    const calc = tryCalculate(q);
    if (calc) { app.showCalculation(q, calc.display, calc.expression); reset(); return; }
    // Before a model is ready the box still does something useful: a plain web search.
    if (!app.canAnswer() && !app.isBusy()) { webSearch(q); return; }
    void app.askQuestion(q, { ground: ground.checked && !ground.disabled && !groundToggle.hidden, attachments: attachments.length ? [...attachments] : null });
    reset();
  };

  $('ask-form').onsubmit = (e) => { e.preventDefault(); submit(); };
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); forceSearch = e.metaKey || e.ctrlKey; submit(); }
    if (e.key === 'Escape') hits.hidden = true;
  });
  $('web-search').onclick = (e) => { e.preventDefault(); if (prompt.value.trim()) webSearch(prompt.value.trim()); };
  $('stop-btn').onclick = () => app.stop();

  // Bookmark search as you type. Local, instant, and the reason a few letters are enough.
  if (bookmarksAvailable()) {
    const render = async (q: string) => {
      const [found, live, stored] = await Promise.all([searchBookmarks(q), searchOpenTabs(q, 3), searchSavedTabs(q, 5)]);
      const saved = withoutOpen(stored, live);
      clear(hits);
      hits.hidden = found.length === 0 && live.length === 0 && saved.length === 0;
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
      // Open before saved: one click switches to it, where a saved tab has to be reopened.
      if (live.length) {
        if (found.length) hits.append(el('div', { class: 'divider' }, 'Open tabs'));
        for (const h of live) {
          hits.append(el('button', {
            class: 'hit saved', type: 'button', title: h.tab.url,
            onclick: () => { hits.hidden = true; void activateTab(h.tab.tabId, h.tab.windowId); },
          } as any,
            el('img', { src: browser.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(h.tab.url)}&size=32` as any), alt: '' }),
            el('span', { class: 't' }, h.tab.title),
            el('span', { class: 'h' }, hostOf(h.tab.url)),
            el('span', { class: 'tag' }, h.window.current ? 'this window' : 'open')));
        }
      }
      if (saved.length) {
        if (found.length || live.length) hits.append(el('div', { class: 'divider' }, 'Saved tabs'));
        for (const h of saved) {
          hits.append(el('a', { class: 'hit saved', href: h.tab.url, title: h.tab.url },
            el('img', { src: browser.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(h.tab.url)}&size=32` as any), alt: '' }),
            el('span', { class: 't' }, h.tab.title),
            el('span', { class: 'h' }, `${h.session.name} · ${hostOf(h.tab.url)}`),
            el('span', { class: 'tag' }, 'saved tab')));
        }
      }
    };
    prompt.addEventListener('input', debounce(() => void render(prompt.value), 120));
    document.addEventListener('click', (e) => { if (!hits.contains(e.target as Node) && e.target !== prompt) hits.hidden = true; });
  }
}

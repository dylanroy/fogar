import { LocalProvider } from '@/lib/llm/local';
import { CloudProvider } from '@/lib/llm/cloud';
import { modelById } from '@/lib/llm/models';
import { SYSTEM_PROMPT, type Message, type Mode, type Provider, type Settings } from '@/lib/llm/types';
import { groundedMessages, groundingConfigured, searchWeb, type Source } from '@/lib/grounding';
import { loadSettings, saveSettings } from '@/lib/settings';
import { $, clear, el } from '@/lib/dom';
import { browser } from 'wxt/browser';
import { bookmarksAvailable, removeBookmark } from '@/lib/bookmarks';
import { BOOKMARK_INTENT, bookmarkCriterion, findBookmarks } from '@/lib/bookmark-agent';
import { renderMarkdown } from '@/lib/markdown';
import { tryCalculate } from '@/lib/calc';
import { contextBlock, type PageContext } from '@/lib/page-context';
import type { DeviceProfile } from '@/lib/device';
import type { ModelSpec } from '@/lib/llm/models';

const all = (root: HTMLElement, sel: string) => Array.from(root.querySelectorAll<HTMLElement>(sel));

export interface AskOptions {
  /** Label shown above the answer, e.g. the recipe name. */
  label?: string;
  /** Fetch web results first and answer from them. */
  ground?: boolean;
  /** The plain question: shown on the card, used as the search query, and stored in history. */
  question?: string;
  /** Let the model reason first (local thinking models only). */
  think?: boolean;
  /** Answer with this provider instead of the current mode's. */
  provider?: Provider;
  /** The page a right-click question came from. */
  context?: PageContext | null;
}

/** One question and its answer, as shown on a card. "Dig deeper" re-asks and replaces it. */
export interface Exchange {
  question: string;
  answer: string;
  context: PageContext | null;
  grounded: boolean;
  thought: boolean;
  via: Mode;
}

export interface QuestionOptions {
  ground?: boolean;
  think?: boolean;
  provider?: Provider;
  context?: PageContext | null;
  /** Remove this earlier exchange from the conversation before asking, so the new answer replaces it. */
  supersede?: Exchange | null;
}
const HISTORY_CHAR_BUDGET = 9000; // ~2,500 tokens of context left for the conversation; the rest is for the answer

/** Shared state and the core actions every panel needs. UI modules attach to this. */
export class App {
  settings!: Settings;
  readonly local = new LocalProvider();
  /** The conversation so far, user and assistant turns only. Lives as long as this tab. */
  history: Message[] = [];
  device: DeviceProfile | null = null;
  recommended: ModelSpec | null = null;
  private abort: AbortController | null = null;
  private loading = false;
  private loadPromise: Promise<boolean> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  /** How long a hidden tab keeps the model in memory before letting it go. Tests shorten this. */
  releaseAfterMs = 5 * 60_000;
  private readonly readyListeners = new Set<() => void>();
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  async init(): Promise<void> {
    this.settings = await loadSettings();
    document.addEventListener('visibilitychange', () => this.onVisibility());
    $('thread-clear').onclick = () => this.clearThread();
    // One listener closes any open "Dig deeper" menu on an outside click.
    document.addEventListener('click', (e) => {
      for (const m of document.querySelectorAll<HTMLElement>('.dig-menu:not([hidden])')) {
        if (!m.parentElement!.contains(e.target as Node)) { m.hidden = true; m.parentElement!.querySelector('.dig-btn')?.setAttribute('aria-expanded', 'false'); }
      }
    });
  }

  /** Cloud is usable when an endpoint and model are set; a key is optional for localhost servers like Ollama. */
  cloudConfigured(): boolean {
    const c = this.settings.cloud;
    return Boolean(c.endpoint && c.model && (c.apiKey || /localhost|127\.0\.0\.1/.test(c.endpoint)));
  }

  async save(): Promise<void> {
    await saveSettings(this.settings);
  }

  onReadyChange(cb: () => void): void {
    this.readyListeners.add(cb);
  }

  /** A cached model that will load the moment the user shows intent. True only after a first successful load. */
  autoLoadPending(): boolean {
    return this.settings.mode === 'local' && this.settings.autoLoad && this.settings.onboarded && !this.local.loaded;
  }

  /** Can a question be taken right now, counting a model that will load on demand? */
  canAnswer(): boolean {
    return this.isReady() || this.autoLoadPending();
  }

  /**
   * Load the cached model if it is not loaded yet. Opening a new tab does not load anything: most new tabs are
   * for typing a URL, and every load costs seconds of GPU work and up to 2.7 GB of memory per tab. Typing a
   * question, clicking a recipe, or asking does.
   */
  ensureModel(): Promise<boolean> {
    if (this.isReady()) return Promise.resolve(true);
    if (this.settings.mode !== 'local' || !this.autoLoadPending()) return Promise.resolve(this.isReady());
    if (!this.loadPromise) this.loadPromise = this.loadModel().finally(() => { this.loadPromise = null; });
    return this.loadPromise;
  }

  /** A tab nobody is looking at gives the model back after a while; the next interaction reloads it from disk. */
  private onVisibility(): void {
    clearTimeout(this.releaseTimer);
    if (!document.hidden) return;
    this.releaseTimer = setTimeout(async () => {
      if (!document.hidden || this.isBusy() || !this.local.loaded || this.loading) return;
      await this.local.unload();
      document.body.dataset.status = 'idle';
      this.refreshReadiness();
    }, this.releaseAfterMs);
  }

  isReady(): boolean {
    return this.settings.mode === 'cloud'
      ? Boolean(this.settings.cloud.endpoint && this.settings.cloud.model)
      : this.local.loaded !== null;
  }

  isBusy(): boolean {
    return document.body.dataset.status === 'answering';
  }

  provider(): Provider {
    return this.settings.mode === 'cloud' ? new CloudProvider(this.settings.cloud) : this.local;
  }

  setMode(mode: Mode): void {
    this.settings.mode = mode;
    $('mode-local').setAttribute('aria-checked', String(mode === 'local'));
    $('mode-cloud').setAttribute('aria-checked', String(mode === 'cloud'));
    $('local-settings').hidden = mode !== 'local';
    $('cloud-settings').hidden = mode !== 'cloud';
    this.refreshReadiness();
    void this.save();
  }

  setStatus(text: string): void {
    $('status').textContent = text;
  }

  refreshReadiness(): void {
    const ready = this.isReady();
    const can = this.canAnswer();
    $<HTMLButtonElement>('ask-btn').disabled = !can || this.isBusy();
    $('web-search').hidden = can;
    $('ground-toggle').hidden = !groundingConfigured(this.settings.grounding);
    if (this.settings.mode === 'local') {
      const gpu = this.settings.gpu && LocalProvider.hasWebGPU() && !this.local.fellBackToCpu;
      this.setStatus(this.local.loaded
        ? `Ready · ${this.local.loaded.label} · ${gpu ? 'WebGPU' : 'CPU'}`
        : this.loading ? $('status').textContent ?? ''
          : this.autoLoadPending() ? `${modelById(this.settings.modelId).label} · loads when you start typing`
            : 'No model loaded. Open Settings to download one, or just search.');
    } else {
      let host = '';
      try { host = new URL(this.settings.cloud.endpoint).host; } catch { /* unset */ }
      this.setStatus(ready ? `Ready · ${this.settings.cloud.model} via ${host}` : 'Add a cloud endpoint in Settings.');
    }
    for (const cb of this.readyListeners) cb();
  }

  async loadModel(): Promise<boolean> {
    // One load at a time. A second click mid-download used to tear down the first instance while its OPFS writer
    // still held the file open, and the retry then failed on removeEntry.
    if (this.loading) return false;
    this.loading = true;
    const loadBtn = $<HTMLButtonElement>('load-btn');
    loadBtn.disabled = true;
    const spec = modelById(this.settings.modelId);
    const progress = $('progress'); const bar = $('progress-bar'); const text = $('progress-text');
    progress.hidden = false; document.body.dataset.status = 'loading';
    this.setStatus(`Loading ${spec.label}…`);
    const t0 = performance.now();
    let ok = false;
    try {
      await this.local.load(spec, {
        gpu: this.settings.gpu && LocalProvider.hasWebGPU(),
        onFallback: () => { this.setStatus('WebGPU failed, loading on the CPU instead…'); this.toast('WebGPU failed on this machine. Using the CPU instead.'); },
        onProgress: (f, loaded, total) => {
          bar.style.width = `${Math.round(f * 100)}%`;
          text.textContent = total ? `${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB` : 'Preparing…';
        },
      });
      document.body.dataset.status = 'ready';
      this.settings.autoLoad = true;
      await this.save();
      ok = true;
      console.log(`[fogar] model ready in ${Math.round(performance.now() - t0)} ms`);
    } catch (err) {
      document.body.dataset.status = 'error';
      this.setStatus(`Load failed: ${(err as Error).message}`);
      console.error('[fogar] load failed', err);
    } finally {
      progress.hidden = true;
      this.loading = false;
      loadBtn.disabled = false;
    }
    this.refreshReadiness();
    return ok;
  }

  stop(): void {
    this.abort?.abort();
  }

  clearThread(): void {
    this.abort?.abort();
    this.history = [];
    for (const card of document.querySelectorAll('#thread .answer-card')) card.remove();
    $('thread-head').hidden = true;
    $('examples').hidden = false;
    document.body.dataset.status = 'idle';
  }

  /**
   * Start a new card at the top of the thread. The newest card owns the well-known ids (answer, stats, sources…);
   * older cards lose them and collapse to their question line.
   */
  newCard(label: string, question?: string): { card: HTMLElement; answer: HTMLElement; links: HTMLElement; sources: HTMLElement; stats: HTMLElement } {
    const thread = $('thread');
    for (const prev of all(thread, '.answer-card')) {
      for (const node of prev.querySelectorAll('[id]')) {
        const id = node.getAttribute('id')!;
        node.classList.add(id); node.removeAttribute('id');
      }
      prev.removeAttribute('id');
      if (!prev.classList.contains('past')) {
        prev.classList.add('past');
        const head = prev.querySelector('.answer-head') as HTMLElement | null;
        if (head) head.onclick = () => prev.classList.toggle('open');
      }
    }
    const answer = el('div', { id: 'answer', class: 'answer' });
    const links = el('ul', { id: 'answer-links', class: 'links', hidden: true });
    const sources = el('ol', { id: 'sources', class: 'sources', hidden: true });
    const stats = el('div', { id: 'stats', class: 'stats' });
    const copy = el('button', { id: 'copy-btn', class: 'ghost small copy-btn', type: 'button', onclick: async () => {
      await navigator.clipboard.writeText(answer.dataset.raw ?? answer.textContent ?? ''); this.toast('Copied');
    } }, 'Copy');
    const card = el('article', { id: 'answer-card', class: 'card answer-card' },
      el('div', { class: 'answer-head' },
        el('span', { class: 'answer-q' }, question ?? ''),
        el('span', { class: 'answer-actions' }, el('span', { id: 'answer-label', class: 'muted answer-label' }, label), copy)),
      answer, links, sources, stats);
    thread.prepend(card);
    $('thread-head').hidden = false;
    $('examples').hidden = true;
    return { card, answer, links, sources, stats };
  }

  /** Drop one exchange from the conversation. Used when a better answer replaces it. */
  private forgetExchange(ex: Exchange): void {
    for (let i = 0; i + 1 < this.history.length; i += 2) {
      if (this.history[i]!.content === ex.question && this.history[i + 1]!.content === ex.answer) { this.history.splice(i, 2); return; }
    }
  }

  private pushHistory(user: string, assistant: string): void {
    if (!assistant.trim()) return;
    this.history.push({ role: 'user', content: user }, { role: 'assistant', content: assistant });
    let size = this.history.reduce((n, m) => n + m.content.length, 0);
    while (size > HISTORY_CHAR_BUDGET && this.history.length > 2) {
      size -= this.history[0]!.content.length + this.history[1]!.content.length;
      this.history.splice(0, 2);
    }
  }

  /** Ask a plain question. Arithmetic is computed, bookmark questions go to the finder, the rest to the model with the conversation so far. */
  async askQuestion(question: string, opts: QuestionOptions = {}): Promise<void> {
    const calc = tryCalculate(question);
    if (calc) { this.showCalculation(question, calc.display, calc.expression); return; }
    if (!opts.context && BOOKMARK_INTENT.test(question) && bookmarksAvailable()) { await this.findBookmarks(question); return; }
    if (opts.supersede) this.forgetExchange(opts.supersede);
    const system = opts.context ? `${SYSTEM_PROMPT}\n\n${contextBlock(opts.context)}` : SYSTEM_PROMPT;
    const messages: Message[] = [{ role: 'system', content: system }, ...this.history, { role: 'user', content: question }];
    await this.ask(messages, { question, ground: opts.ground, think: opts.think, provider: opts.provider, context: opts.context ?? null });
  }

  showCalculation(question: string, display: string, expression: string): void {
    const { answer, stats } = this.newCard('Calculator', question);
    answer.append(el('div', { class: 'big' }, display));
    answer.dataset.raw = display;
    stats.textContent = `${expression} = ${display} · computed locally, no model involved`;
    document.body.dataset.status = 'done';
  }

  /** Stream a conversation into a new card. `messages` is sent as given; history is appended afterwards. */
  async ask(messages: Message[], opts: AskOptions = {}): Promise<void> {
    if (!this.isReady() && !(await this.ensureModel())) return;
    this.abort?.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const question = opts.question ?? lastUser;
    const provider = opts.provider ?? this.provider();
    const via: Mode = opts.provider ? (opts.provider instanceof CloudProvider ? 'cloud' : 'local') : this.settings.mode;
    const think = !!opts.think && via === 'local' && !!this.local.loaded?.canThink;
    const label = opts.label ?? (think ? 'Thought longer' : opts.provider ? (via === 'cloud' ? 'Cloud answer' : 'Local answer') : 'Answer');
    const { card, answer, sources: sourcesEl, stats } = this.newCard(label, opts.label && !opts.question ? undefined : question);
    if (opts.context) {
      let host = opts.context.url; try { host = new URL(opts.context.url).host.replace(/^www\./, ''); } catch { /* keep */ }
      card.querySelector('.answer-q')?.append(' ', el('a', { class: 'ctx-chip', href: opts.context.url, target: '_blank', rel: 'noopener', title: opts.context.title || opts.context.url }, `from ${host}`));
    }
    document.body.dataset.status = 'answering';
    $('stop-btn').hidden = false;
    this.refreshReadiness();

    // Thinking streams into a collapsed block above the answer, so the monologue is there but not in the way.
    const thinking = { box: null as HTMLDetailsElement | null, summary: null as HTMLElement | null, thought: null as HTMLElement | null, text: '', startedAt: performance.now() };
    const onReasoning = (t: string) => {
      if (!thinking.box) {
        thinking.summary = el('summary', {}, 'Thinking…');
        thinking.thought = el('div', { class: 'thought' });
        thinking.box = el('details', { class: 'thinking' }, thinking.summary, thinking.thought);
        answer.before(thinking.box);
      }
      thinking.text += t; thinking.thought!.textContent = thinking.text;
    };
    const markThought = () => { if (thinking.summary && thinking.summary.textContent === 'Thinking…') thinking.summary.textContent = `Thought for ${((performance.now() - thinking.startedAt) / 1000).toFixed(1)} s`; };

    let sources: Source[] = [];
    let raw = ''; let frame = 0;
    const paint = () => { frame = 0; renderMarkdown(raw, answer); answer.dataset.raw = raw; };
    const t0 = performance.now(); let tokens = 0; let firstAt = 0;
    try {
      if (opts.ground && groundingConfigured(this.settings.grounding)) {
        this.setStatus('Searching the web…');
        sources = await searchWeb(question, this.settings.grounding, signal);
        if (sources.length) {
          const system = messages[0]?.role === 'system' ? messages[0].content : SYSTEM_PROMPT;
          messages = groundedMessages(system, question, sources, this.history);
          sourcesEl.hidden = false;
          for (const s of sources) {
            let host = s.url; try { host = new URL(s.url).host.replace(/^www\./, ''); } catch { /* keep */ }
            sourcesEl.append(el('li', {}, el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.title), ' ', el('span', { class: 'muted' }, s.via ?? host)));
          }
        }
        this.setStatus('Answering…');
      }
      for await (const token of provider.ask(messages, signal, { think, onReasoning })) {
        if (!firstAt) firstAt = performance.now();
        markThought();
        tokens++;
        raw += token;
        if (!frame) frame = requestAnimationFrame(paint);
      }
      if (frame) cancelAnimationFrame(frame);
      paint();
      markThought();
      if (!raw.trim() && thinking.text) {
        answer.textContent = 'The model used all its room thinking and never reached an answer. Try again, or ask something narrower.';
        if (thinking.box) thinking.box.open = true;
      }
      const total = performance.now() - t0;
      const gen = Math.max(1, total - (firstAt - t0));
      stats.textContent = `${tokens} tokens · first token ${Math.round(firstAt - t0)} ms · ${(tokens / (gen / 1000)).toFixed(1)} tok/s${sources.length ? ` · ${sources.length} sources` : ''}${thinking.text ? ` · ${thinking.text.length} chars of thinking` : ''}`;
      this.pushHistory(question, raw);
      if (!opts.label) this.attachDigMenu(card, { question, answer: raw, context: opts.context ?? null, grounded: sources.length > 0, thought: think, via });
      document.body.dataset.status = 'done';
    } catch (err) {
      if (frame) cancelAnimationFrame(frame);
      if (signal.aborted) {
        paint();
        document.body.dataset.status = 'done';
        stats.textContent = 'Stopped.';
        this.pushHistory(question, raw);
      } else {
        document.body.dataset.status = 'error';
        answer.textContent = `Error: ${(err as Error).message}`;
        console.error('[fogar] ask failed', err);
      }
    } finally {
      $('stop-btn').hidden = true;
      this.refreshReadiness();
    }
  }

  /**
   * "Dig deeper": the ways that actually produce a better answer. Each re-asks the same question with the
   * conversation as it was, and the new card replaces this one in the model's memory.
   */
  private attachDigMenu(card: HTMLElement, ex: Exchange): void {
    const actions = card.querySelector('.answer-actions');
    if (!actions) return;
    const menu = el('div', { class: 'menu dig-menu', role: 'menu', hidden: true });
    const btn = el('button', { class: 'ghost small dig-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' } as any, 'Dig deeper');
    btn.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      // Older cards toggle open on a head click; the menu must not double as that toggle.
      menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) fill();
    };
    const item = (title: string, note: string, onclick: (() => void) | null, disabled = false) =>
      el('button', { class: 'menu-item', type: 'button', role: 'menuitem', disabled, onclick: () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); onclick?.(); } } as any,
        el('strong', {}, title), el('span', { class: 'muted' }, note));
    const reask = (extra: QuestionOptions) => void this.askQuestion(ex.question, { context: ex.context, supersede: ex, ...extra });
    const fill = () => {
      clear(menu);
      const groundOk = groundingConfigured(this.settings.grounding);
      menu.append(ex.grounded
        ? item('Search the web and answer again', 'This answer already used web results.', null, true)
        : groundOk
          ? item('Search the web and answer again', this.settings.grounding.provider === 'free' ? 'DuckDuckGo instant answers and Wikipedia, cited. No key. Best for well-known people, places, and terms.' : 'Five live results, cited. Best for facts, names, and anything recent.', () => reask({ ground: true }))
          : item('Search the web and answer again', 'Web grounding is off. Opens Settings; the free option needs no key.', () => { $<HTMLDetailsElement>('settings').open = true; $('grounding-settings').scrollIntoView({ block: 'center', behavior: 'smooth' }); }));
      if (this.settings.mode === 'local' && this.local.loaded?.canThink) {
        menu.append(ex.thought
          ? item('Think longer', 'This answer already used thinking.', null, true)
          : item('Think longer', 'Lets the model reason before answering. Slower, better on multi-step questions.', () => reask({ think: true })));
      }
      if (ex.via === 'local' && this.cloudConfigured()) {
        menu.append(item('Ask the cloud model', `Same question and conversation, answered by ${this.settings.cloud.model}.`, () => reask({ provider: new CloudProvider(this.settings.cloud) })));
      } else if (ex.via === 'cloud' && this.local.loaded) {
        menu.append(item('Ask the local model', `Same question, answered by ${this.local.loaded.label} on this device.`, () => reask({ provider: this.local })));
      }
    };
    menu.onclick = (e: MouseEvent) => e.stopPropagation();
    actions.prepend(el('span', { class: 'menu-wrap dig' }, btn, menu));
  }

  /** The model cannot see bookmarks, so the finder reads them and lets the model pick. Results are links, not prose. */
  async findBookmarks(question: string): Promise<void> {
    if (!this.isReady() && !(await this.ensureModel())) return;
    this.abort?.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const { answer, links, stats } = this.newCard('Bookmarks', question);
    document.body.dataset.status = 'answering';
    $('stop-btn').hidden = false;
    this.refreshReadiness();
    const t0 = performance.now();
    try {
      this.setStatus('Reading your bookmarks…');
      const result = await findBookmarks(question, this.provider(), signal, (scanned, total, phase) => {
        if (phase === 'expanding') { this.setStatus('Thinking about what to look for…'); answer.textContent = `Working out what “${bookmarkCriterion(question)}” bookmarks look like…`; }
        else { this.setStatus(`Reading bookmarks… ${scanned} of ${total}`); answer.textContent = `Reading ${total} bookmarks for “${bookmarkCriterion(question)}”…`; }
      });
      const what = result.listedAll ? 'your newest bookmarks' : `“${result.criterion}”`;
      answer.textContent = result.hits.length
        ? `${result.hits.length} bookmark${result.hits.length === 1 ? '' : 's'} ${result.listedAll ? '' : 'about '}${what}.`
        : `No bookmarks about ${what}. I read all ${result.total}.`;
      if (result.terms.length) answer.append(el('div', { class: 'muted small-note' }, `Looked for: ${result.terms.slice(0, 14).join(', ')}`));
      answer.dataset.raw = result.hits.map((b) => `${b.title} ${b.url}`).join('\n');
      if (result.hits.length) {
        links.hidden = false;
        for (const b of result.hits) {
          let h = ''; try { h = new URL(b.url).host.replace(/^www\./, ''); } catch { /* keep */ }
          const row = el('a', { class: 'hit', href: b.url, target: '_blank', rel: 'noopener' },
            el('img', { src: browser.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(b.url)}&size=32` as any), alt: '' }),
            el('span', { class: 't' }, b.title), el('span', { class: 'h' }, h),
            el('button', { class: 'x', type: 'button', title: 'Remove bookmark', onclick: async (ev: MouseEvent) => {
              ev.preventDefault(); ev.stopPropagation();
              if (!confirm(`Remove bookmark “${b.title}”?`)) return;
              await removeBookmark(b.id); row.remove(); this.toast('Bookmark removed');
            } }, '×'));
          links.append(el('li', {}, row));
        }
      }
      stats.textContent = `${result.total} bookmarks · ${result.keywordHits} matched by words, ${result.modelHits} picked by the model · ${Math.round(performance.now() - t0)} ms`;
      document.body.dataset.status = 'done';
    } catch (err) {
      if (signal.aborted) { document.body.dataset.status = 'done'; stats.textContent = 'Stopped.'; }
      else { document.body.dataset.status = 'error'; answer.textContent = `Error: ${(err as Error).message}`; console.error('[fogar] bookmark find failed', err); }
    } finally {
      $('stop-btn').hidden = true;
      this.refreshReadiness();
    }
  }

  toast(text: string): void {
    const t = $('toast'); t.textContent = text; t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }
}


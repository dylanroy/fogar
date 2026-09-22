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
}

const FACTUAL = /^(who|what|when|where|which|how many|how much|how old|is|are|was|were|did|does|do)\b/i;
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
  private readonly readyListeners = new Set<() => void>();
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  async init(): Promise<void> {
    this.settings = await loadSettings();
    $('thread-clear').onclick = () => this.clearThread();
  }

  async save(): Promise<void> {
    await saveSettings(this.settings);
  }

  onReadyChange(cb: () => void): void {
    this.readyListeners.add(cb);
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
    $<HTMLButtonElement>('ask-btn').disabled = !ready || this.isBusy();
    $('web-search').hidden = ready;
    $('ground-toggle').hidden = !groundingConfigured(this.settings.grounding);
    if (this.settings.mode === 'local') {
      const gpu = this.settings.gpu && LocalProvider.hasWebGPU() && !this.local.fellBackToCpu;
      this.setStatus(this.local.loaded
        ? `Ready · ${this.local.loaded.label} · ${gpu ? 'WebGPU' : 'CPU'}`
        : this.loading ? $('status').textContent ?? '' : 'No model loaded. Open Settings to download one, or just search.');
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
  async askQuestion(question: string, ground: boolean): Promise<void> {
    const calc = tryCalculate(question);
    if (calc) { this.showCalculation(question, calc.display, calc.expression); return; }
    if (BOOKMARK_INTENT.test(question) && bookmarksAvailable()) { await this.findBookmarks(question); return; }
    const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history, { role: 'user', content: question }];
    await this.ask(messages, { question, ground });
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
    if (!this.isReady()) return;
    this.abort?.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const question = opts.question ?? lastUser;
    const { card, answer, sources: sourcesEl, stats } = this.newCard(opts.label ?? 'Answer', opts.label && !opts.question ? undefined : question);
    document.body.dataset.status = 'answering';
    $('stop-btn').hidden = false;
    this.refreshReadiness();

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
            sourcesEl.append(el('li', {}, el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.title), ' ', el('span', { class: 'muted' }, host)));
          }
        }
        this.setStatus('Answering…');
      }
      for await (const token of this.provider().ask(messages, signal)) {
        if (!firstAt) firstAt = performance.now();
        tokens++;
        raw += token;
        if (!frame) frame = requestAnimationFrame(paint);
      }
      if (frame) cancelAnimationFrame(frame);
      paint();
      const total = performance.now() - t0;
      const gen = Math.max(1, total - (firstAt - t0));
      stats.textContent = `${tokens} tokens · first token ${Math.round(firstAt - t0)} ms · ${(tokens / (gen / 1000)).toFixed(1)} tok/s${sources.length ? ` · ${sources.length} sources` : ''}`;
      this.pushHistory(question, raw);
      if (!sources.length && this.settings.mode === 'local' && !opts.label && FACTUAL.test(question) && !groundingConfigured(this.settings.grounding)) {
        card.append(el('div', { class: 'nudge' }, 'Small local models guess at facts. ', el('a', { href: '#grounding-settings', onclick: () => { $<HTMLDetailsElement>('settings').open = true; } }, 'Add a search key'), ' to answer from web results with sources.'));
      }
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

  /** The model cannot see bookmarks, so the finder reads them and lets the model pick. Results are links, not prose. */
  async findBookmarks(question: string): Promise<void> {
    if (!this.isReady()) return;
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


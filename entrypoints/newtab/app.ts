import { LocalProvider } from '@/lib/llm/local';
import { CloudProvider } from '@/lib/llm/cloud';
import { modelById } from '@/lib/llm/models';
import { SYSTEM_PROMPT, type Message, type Mode, type Provider, type Settings } from '@/lib/llm/types';
import { groundedMessages, groundingConfigured, searchWeb, type Source } from '@/lib/grounding';
import { loadSettings, saveSettings } from '@/lib/settings';
import { $, clear, el } from '@/lib/dom';

export interface AskOptions {
  /** Label shown above the answer, e.g. the recipe name. */
  label?: string;
  /** Fetch web results first and answer from them. */
  ground?: boolean;
  /** The plain question, used as the search query when grounding. */
  question?: string;
}

/** Shared state and the core actions every panel needs. UI modules attach to this. */
export class App {
  settings!: Settings;
  readonly local = new LocalProvider();
  private abort: AbortController | null = null;
  private loading = false;
  private readonly readyListeners = new Set<() => void>();
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  async init(): Promise<void> {
    this.settings = await loadSettings();
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
      const gpu = this.settings.gpu && LocalProvider.hasWebGPU();
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
        onProgress: (f, loaded, total) => {
          bar.style.width = `${Math.round(f * 100)}%`;
          text.textContent = total ? `${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB` : 'Preparing…';
        },
      });
      $('stats').textContent = `Model ready in ${Math.round(performance.now() - t0)} ms`;
      document.body.dataset.status = 'ready';
      this.settings.autoLoad = true;
      await this.save();
      ok = true;
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

  /** Ask a plain question. Grounds it first when asked to and a search key is set. */
  async askQuestion(question: string, ground: boolean): Promise<void> {
    const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: question }];
    await this.ask(messages, { question, ground });
  }

  /** Stream a conversation into the answer card. */
  async ask(messages: Message[], opts: AskOptions = {}): Promise<void> {
    if (!this.isReady()) return;
    this.abort?.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const card = $('answer-card'); const answer = $('answer'); const sourcesEl = $('sources'); const stats = $('stats');
    card.hidden = false; answer.textContent = ''; stats.textContent = ''; sourcesEl.hidden = true; clear(sourcesEl);
    $('answer-label').textContent = opts.label ?? 'Answer';
    document.body.dataset.status = 'answering';
    $('stop-btn').hidden = false;
    this.refreshReadiness();

    let sources: Source[] = [];
    const t0 = performance.now(); let tokens = 0; let firstAt = 0;
    try {
      if (opts.ground && groundingConfigured(this.settings.grounding)) {
        this.setStatus('Searching the web…');
        sources = await searchWeb(opts.question ?? messages[messages.length - 1]!.content, this.settings.grounding, signal);
        if (sources.length) {
          messages = groundedMessages(messages[0]?.role === 'system' ? messages[0].content : SYSTEM_PROMPT, opts.question ?? '', sources);
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
        answer.textContent += token;
      }
      const total = performance.now() - t0;
      const gen = Math.max(1, total - (firstAt - t0));
      stats.textContent = `${tokens} tokens · first token ${Math.round(firstAt - t0)} ms · ${(tokens / (gen / 1000)).toFixed(1)} tok/s${sources.length ? ` · ${sources.length} sources` : ''}`;
      document.body.dataset.status = 'done';
    } catch (err) {
      if (signal.aborted) {
        document.body.dataset.status = 'done';
        stats.textContent = 'Stopped.';
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

  toast(text: string): void {
    const t = $('toast'); t.textContent = text; t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }
}

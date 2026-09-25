import { CacheManager, Wllama } from '@wllama/wllama';
import { browser } from 'wxt/browser';
import type { AskOpts, Message, Provider } from './types';
import type { ModelSpec } from './models';

export interface LoadOptions {
  gpu: boolean;
  onProgress: (fraction: number, loadedBytes: number, totalBytes: number) => void;
  /** Called when the WebGPU load failed and the model is being loaded on the CPU instead. */
  onFallback?: (reason: string) => void;
}

/** wllama running inside the extension page, weights cached in OPFS after first download. */
export class LocalProvider implements Provider {
  private wllama: Wllama | null = null;
  loaded: ModelSpec | null = null;
  /** True when the current model ended up on the CPU after a GPU failure. */
  fellBackToCpu = false;

  static hasWebGPU(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  async load(model: ModelSpec, opts: LoadOptions): Promise<void> {
    await this.unload();
    this.fellBackToCpu = false;
    try {
      await this.loadWith(model, opts.gpu, opts.onProgress);
    } catch (err) {
      if (!opts.gpu) throw err;
      // A flaky GPU driver should not leave the product dead. Same weights, CPU path.
      const reason = (err as Error).message;
      console.warn('[fogar] WebGPU load failed, retrying on CPU:', reason);
      opts.onFallback?.(reason);
      await this.unload();
      await this.loadWith(model, false, opts.onProgress);
      this.fellBackToCpu = true;
    }
    this.loaded = model;
  }

  private async loadWith(model: ModelSpec, gpu: boolean, onProgress: LoadOptions['onProgress']): Promise<void> {
    const wasm = browser.runtime.getURL('/wllama/wllama.wasm');
    // allowOffline is stored and never read in wllama 3.6.1; the direct file URL below is what makes a cached load network-free.
    this.wllama = new Wllama({ default: wasm }, { parallelDownloads: 3, allowOffline: true });
    // Browsers without JSPI or Memory64 (Safari before 27) get wllama's compatibility build. From our own origin, not
    // wllama's CDN default: the web build ships it in web/wllama/, and the worker rewrite in
    // lib/vite-plugin-wllama-mv3.ts spawns the static compat worker, so the worker code here is only a placeholder.
    // Chrome has both features and never takes this path.
    this.wllama.setCompat({ worker: { code: '/* static compat worker: see lib/vite-plugin-wllama-mv3.ts */' }, wasm: browser.runtime.getURL('/wllama/wllama-compat.wasm' as any) });
    // Straight to the file, not through the Hugging Face API. wllama's HF helper lists the repo before it looks in the
    // cache and throws with no network, so a cached model would not load offline; the URL loader looks in the cache
    // first and matches on this same address, so models already downloaded stay valid. It was also the last request
    // local mode made after caching: with it gone, a cached model loads with no network at all.
    await this.wllama.loadModelFromUrl(
      `https://huggingface.co/${model.repo}/resolve/main/${model.file}`,
      {
        n_ctx: 4096,
        n_gpu_layers: gpu ? 99 : 0,
        useCache: true,
        // Qwen3 and Qwen3.5 think out loud by default. A new tab wants the answer, not the monologue.
        default_template_kwargs: { enable_thinking: false },
        // When "Think longer" turns reasoning on for one question, cap it. Measured without a cap, the 0.8B spent
        // 1,500 tokens thinking and never answered. llama.cpp closes the thought at the budget and injects this line.
        reasoning_budget_tokens: 600,
        reasoning_budget_message: 'That is enough thinking. I will answer now.',
        progressCallback: ({ loaded, total }: { loaded: number; total: number }) => onProgress(total ? loaded / total : 0, loaded, total),
      } as any,
    );
  }

  async *ask(messages: Message[], signal: AbortSignal, opts: AskOpts = {}): AsyncIterable<string> {
    if (!this.wllama || !this.loaded) throw new Error('No local model loaded');
    const think = !!opts.think && !!this.loaded.canThink;
    // The stream:true overload's type omits abortSignal, but the implementation honours it.
    const stream = (await this.wllama.createChatCompletion({
      messages,
      stream: true,
      max_tokens: opts.maxTokens ?? (think ? 2048 : 768),
      temperature: opts.temperature ?? 0.4,
      abortSignal: signal,
      // Per-call override of the load-time default (thinking off). Qwen3 templates read enable_thinking.
      chat_template_kwargs: { enable_thinking: think },
    } as any)) as unknown as AsyncIterable<any>;

    // Reasoning arrives either as a separate delta field or inline as <think>…</think>. Either way it is routed
    // to onReasoning and kept out of the answer. A partial closing tag is held back until it resolves.
    let buf = ''; let mode: 'start' | 'think' | 'answer' = 'start';
    const reason = (t: string) => { if (t) opts.onReasoning?.(t); };
    for await (const chunk of stream) {
      if (signal.aborted) break;
      const delta = chunk?.choices?.[0]?.delta;
      const separate: string | undefined = delta?.reasoning_content ?? delta?.reasoning;
      if (separate) { reason(separate); continue; }
      const token: string | undefined = delta?.content;
      if (!token) continue;
      if (mode === 'answer') { yield token; continue; }
      buf += token;
      if (mode === 'start') {
        const lead = buf.trimStart();
        if (lead.startsWith('<think>')) { mode = 'think'; buf = lead.slice(7); }
        else if (lead.length < 7 && '<think>'.startsWith(lead)) continue; // could still become <think>
        else { mode = 'answer'; const out = buf; buf = ''; yield out; continue; }
      }
      // mode === 'think'
      const close = buf.indexOf('</think>');
      if (close >= 0) {
        reason(buf.slice(0, close));
        const rest = buf.slice(close + 8).replace(/^\s+/, '');
        buf = ''; mode = 'answer';
        if (rest) yield rest;
      } else if (buf.length > 8) {
        reason(buf.slice(0, -8)); buf = buf.slice(-8);
      }
    }
    if (mode === 'start' && buf) yield buf;
    if (mode === 'think' && buf) reason(buf); // ran out of tokens mid-thought: the caller sees an empty answer
  }

  /** Total bytes of model files cached in OPFS, and a way to clear them. */
  static async cacheSize(): Promise<number> {
    try {
      const entries = await new CacheManager().list();
      return entries.reduce((sum, e) => sum + (e.size ?? 0), 0);
    } catch {
      return 0;
    }
  }

  static async clearCache(): Promise<void> {
    await new CacheManager().clear();
  }

  async unload(): Promise<void> {
    if (this.wllama) {
      try { await this.wllama.exit(); } catch { /* already gone */ }
      this.wllama = null;
      this.loaded = null;
    }
  }
}

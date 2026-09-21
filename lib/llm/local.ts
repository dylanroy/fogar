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
    // allowOffline: once a model is cached, skip the Hugging Face listing call so local mode makes no network requests at all.
    this.wllama = new Wllama({ default: wasm }, { parallelDownloads: 3, allowOffline: true });
    await this.wllama.loadModelFromHF(
      { repo: model.repo, file: model.file },
      {
        n_ctx: 4096,
        n_gpu_layers: gpu ? 99 : 0,
        useCache: true,
        // Qwen3 and Qwen3.5 think out loud by default. A new tab wants the answer, not the monologue.
        default_template_kwargs: { enable_thinking: false },
        progressCallback: ({ loaded, total }: { loaded: number; total: number }) => onProgress(total ? loaded / total : 0, loaded, total),
      } as any,
    );
  }

  async *ask(messages: Message[], signal: AbortSignal, opts: AskOpts = {}): AsyncIterable<string> {
    if (!this.wllama || !this.loaded) throw new Error('No local model loaded');
    // The stream:true overload's type omits abortSignal, but the implementation honours it.
    const stream = (await this.wllama.createChatCompletion({
      messages,
      stream: true,
      max_tokens: opts.maxTokens ?? 768,
      temperature: 0.4,
      abortSignal: signal,
    } as any)) as unknown as AsyncIterable<any>;
    // Belt and braces: if a template still emits a think block, hold it back rather than show it.
    let buffer = ''; let inThink = false; let started = false;
    for await (const chunk of stream) {
      if (signal.aborted) break;
      const token: string | undefined = chunk?.choices?.[0]?.delta?.content;
      if (!token) continue;
      if (!started) {
        buffer += token;
        if (buffer.trimStart().startsWith('<think>')) { inThink = true; started = true; buffer = ''; continue; }
        if (buffer.length < 7 && '<think>'.startsWith(buffer.trimStart())) continue; // could still become <think>
        started = true; yield buffer; buffer = ''; continue;
      }
      if (inThink) {
        buffer += token;
        const end = buffer.indexOf('</think>');
        if (end >= 0) { inThink = false; const rest = buffer.slice(end + 8).replace(/^\s+/, ''); buffer = ''; if (rest) yield rest; }
        continue;
      }
      yield token;
    }
    if (!started && buffer) yield buffer;
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

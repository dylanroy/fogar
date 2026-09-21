import { Wllama } from '@wllama/wllama';
import { browser } from 'wxt/browser';
import type { Message, Provider } from './types';
import type { ModelSpec } from './models';

export interface LoadOptions {
  gpu: boolean;
  onProgress: (fraction: number, loadedBytes: number, totalBytes: number) => void;
}

/** wllama running inside the extension page, weights cached in OPFS after first download. */
export class LocalProvider implements Provider {
  private wllama: Wllama | null = null;
  loaded: ModelSpec | null = null;

  static hasWebGPU(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  async load(model: ModelSpec, opts: LoadOptions): Promise<void> {
    await this.unload();
    const wasm = browser.runtime.getURL('/wllama/wllama.wasm');
    // allowOffline: once a model is cached, skip the Hugging Face listing call so local mode makes no network requests at all.
    this.wllama = new Wllama({ default: wasm }, { parallelDownloads: 3, allowOffline: true });
    await this.wllama.loadModelFromHF(
      { repo: model.repo, file: model.file },
      {
        n_ctx: 2048,
        n_gpu_layers: opts.gpu ? 99 : 0,
        useCache: true,
        progressCallback: ({ loaded, total }: { loaded: number; total: number }) =>
          opts.onProgress(total ? loaded / total : 0, loaded, total),
      },
    );
    this.loaded = model;
  }

  async *ask(messages: Message[], signal: AbortSignal): AsyncIterable<string> {
    if (!this.wllama || !this.loaded) throw new Error('No local model loaded');
    const suffix = this.loaded.noThinkSuffix ?? '';
    const withSuffix = suffix
      ? messages.map((m, i) => (i === 0 && m.role === 'system' ? { ...m, content: m.content + suffix } : m))
      : messages;
    const stream = await this.wllama.createChatCompletion({
      messages: withSuffix,
      stream: true,
      max_tokens: 512,
      temperature: 0.4,
    });
    for await (const chunk of stream as AsyncIterable<any>) {
      if (signal.aborted) break;
      const token: string | undefined = chunk?.choices?.[0]?.delta?.content;
      if (token) yield token;
    }
  }

  async unload(): Promise<void> {
    if (this.wllama) {
      try { await this.wllama.exit(); } catch { /* already gone */ }
      this.wllama = null;
      this.loaded = null;
    }
  }
}

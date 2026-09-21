// Feasibility spike: can an offscreen document host wllama with WebGPU, so every new tab shares one model?
import { LocalProvider } from '@/lib/llm/local';
import { modelById } from '@/lib/llm/models';
import { browser } from 'wxt/browser';

async function spike(modelId: string, gpu: boolean) {
  const out: Record<string, unknown> = { where: 'offscreen', modelId, gpu };
  try {
    const adapter = await (navigator as any).gpu?.requestAdapter?.();
    out.webgpu = !!adapter; out.gpuInfo = adapter?.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture } : null;
    out.sab = typeof SharedArrayBuffer !== 'undefined'; out.crossOriginIsolated = (self as any).crossOriginIsolated;
    const local = new LocalProvider();
    const t0 = performance.now();
    await local.load(modelById(modelId), { gpu, onProgress: () => {} });
    out.loadMs = Math.round(performance.now() - t0); out.cpuFallback = local.fellBackToCpu;
    const t1 = performance.now(); let text = ''; let tokens = 0;
    for await (const t of local.ask([{ role: 'user', content: 'Say hello in five words.' }], new AbortController().signal, { maxTokens: 30 })) { text += t; tokens++; }
    out.genMs = Math.round(performance.now() - t1); out.tokens = tokens; out.text = text.slice(0, 200);
  } catch (err) {
    out.error = (err as Error).message;
  }
  await browser.runtime.sendMessage({ type: 'offscreen.result', result: out }).catch(() => {});
}

browser.runtime.onMessage.addListener((msg: any) => {
  console.log('[fogar] offscreen got message', msg?.type);
  if (msg?.type === 'offscreen.spike') void spike(msg.modelId ?? 'smoke', msg.gpu !== false);
});
console.log('[fogar] offscreen document booted');
void browser.runtime.sendMessage({ type: 'offscreen.ready' }).catch(() => {});

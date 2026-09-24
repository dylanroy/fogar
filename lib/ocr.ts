import { browser } from 'wxt/browser';
import type { ModelKind } from './chat-models';
import { anthropicHeaders } from './llm/anthropic';

/**
 * Reading text out of a photo, two ways.
 *
 * On this device: Tesseract compiled to WebAssembly, shipped inside the extension with its English data, so a
 * scan never leaves the browser. Good on printed and typed text, weak on handwriting.
 *
 * With a model: the photo goes to a vision model the user chose (their own key, their own endpoint), which
 * reads handwriting well. The image is downscaled and re-encoded first so a 12 MB phone photo does not go
 * over the wire; nothing is stored.
 */
export interface OcrProgress { status: string; progress: number }

export interface PreparedImage { blob: Blob; dataUrl: string; mime: 'image/jpeg'; width: number; height: number }

const MAX_SIDE = 2000;

/** Downscale to at most 2000 px on the long side and re-encode as JPEG. `enhance` flattens colour and stretches contrast for OCR. */
export async function prepareImage(file: Blob, opts: { maxSide?: number; enhance?: boolean } = {}): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('That file is not an image Fogar can open.'); });
  const maxSide = opts.maxSide ?? MAX_SIDE;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale)); const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  if (opts.enhance) {
    const img = ctx.getImageData(0, 0, width, height); const d = img.data;
    let lo = 255; let hi = 0;
    for (let i = 0; i < d.length; i += 4) { const g = (d[i]! * 299 + d[i + 1]! * 587 + d[i + 2]! * 114) / 1000; d[i] = d[i + 1] = d[i + 2] = g; if (g < lo) lo = g; if (g > hi) hi = g; }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, Math.min(255, ((d[i]! - lo) / range) * 255)); d[i] = d[i + 1] = d[i + 2] = v; }
    ctx.putImageData(img, 0, 0);
  }
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the image.'))), 'image/jpeg', 0.9));
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return { blob, dataUrl, mime: 'image/jpeg', width, height };
}

// ---------- on this device ----------

type TesseractModule = typeof import('tesseract.js');
type TesseractWorker = Awaited<ReturnType<TesseractModule['createWorker']>>;

let worker: TesseractWorker | null = null;
let workerPromise: Promise<TesseractWorker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

/** English is inside the extension. Other languages would be fetched from tesseract's CDN; they are not offered yet. */
export const LOCAL_OCR_LANG = 'eng';

// The same probes wasm-feature-detect uses: a module that only validates when the browser knows the instructions.
const RELAXED_SIMD = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11];
const SIMD = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11];

/** Which of the two shipped cores this browser can run. Every Chrome that runs Manifest V3 has SIMD; relaxed SIMD came in 114. */
export async function coreFile(): Promise<string> {
  const ok = (bytes: number[]) => { try { return WebAssembly.validate(new Uint8Array(bytes)); } catch { return false; } };
  if (ok(RELAXED_SIMD)) return 'tesseract-core-relaxedsimd-lstm.js';
  if (ok(SIMD)) return 'tesseract-core-simd-lstm.js';
  throw new Error('This browser cannot run the on-device reader. Pick a model under “read with” instead.');
}

async function getWorker(onProgress?: (p: OcrProgress) => void): Promise<TesseractWorker> {
  clearTimeout(idleTimer);
  if (worker) return worker;
  if (!workerPromise) {
    workerPromise = (async () => {
      const T = (await import('tesseract.js/dist/tesseract.esm.min.js')).default;
      // Static files inside the extension: Manifest V3 allows no blob: workers and no remote code. The core is
      // named outright (the worker would otherwise pick one from a directory of three); the language data is
      // local too, so cacheMethod is off, since a copy in IndexedDB would only double the bytes on disk.
      const w = await T.createWorker(LOCAL_OCR_LANG, T.OEM.LSTM_ONLY, {
        workerPath: browser.runtime.getURL('/tesseract/worker.min.js' as any),
        corePath: browser.runtime.getURL(`/tesseract/${await coreFile()}` as any),
        langPath: browser.runtime.getURL('/tesseract/lang' as any),
        workerBlobURL: false, gzip: true, cacheMethod: 'none',
        logger: (m: { status: string; progress: number }) => onProgress?.({ status: m.status, progress: m.progress }),
      });
      worker = w;
      return w;
    })().finally(() => { workerPromise = null; });
  }
  return workerPromise;
}

/** Let the worker go after a quiet while; the next photo pays the second of start-up again. */
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { void worker?.terminate(); worker = null; }, 120_000);
}

export async function recognizeLocal(image: PreparedImage, onProgress?: (p: OcrProgress) => void): Promise<string> {
  const w = await getWorker(onProgress);
  try {
    const { data } = await w.recognize(image.blob);
    return tidyOcr(data.text);
  } finally {
    scheduleIdle();
  }
}

/** Tesseract leaves stray line breaks inside paragraphs and blank runs between them. Keep paragraphs, join lines. */
export function tidyOcr(text: string): string {
  return text
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

// ---------- with a model ----------

export interface VisionTarget { kind: ModelKind; endpoint: string; apiKey: string; model: string }

const OCR_PROMPT = 'Transcribe every word of text in this image, in reading order, keeping line and paragraph breaks. Preserve lists, headings, and tables as plain text. Return only the transcription, with no commentary. If some part is illegible, write [illegible] in its place.';

/** The photo and the instruction go to the model once; the answer is the text. */
export async function recognizeWithModel(image: PreparedImage, target: VisionTarget, signal?: AbortSignal, prompt = OCR_PROMPT): Promise<string> {
  const base = target.endpoint.replace(/\/+$/, '');
  const b64 = image.dataUrl.slice(image.dataUrl.indexOf(',') + 1);
  if (target.kind === 'anthropic') {
    const res = await fetch(`${base.replace(/\/v1$/, '')}/v1/messages`, {
      method: 'POST', signal, headers: anthropicHeaders(target.apiKey),
      body: JSON.stringify({ model: target.model, max_tokens: 4096, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: image.mime, data: b64 } }, { type: 'text', text: prompt }] }] }),
    });
    if (!res.ok) throw new Error(`Anthropic returned ${res.status}${await errorDetail(res)}`);
    const data = await res.json();
    if (data.stop_reason === 'refusal') throw new Error('The model declined to read this image.');
    return tidyOcr(((data.content ?? []) as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'));
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}) },
    body: JSON.stringify({ model: target.model, max_tokens: 4096, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image.dataUrl } }] }] }),
  });
  if (!res.ok) throw new Error(`The endpoint returned ${res.status}${await errorDetail(res)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('') : '';
  if (!text.trim()) throw new Error('The model returned no text. Does it read images?');
  return tidyOcr(text);
}

async function errorDetail(res: Response): Promise<string> {
  try { const j = await res.json(); const m = j?.error?.message ?? j?.message; return m ? `: ${String(m).slice(0, 160)}` : ''; } catch { return ''; }
}

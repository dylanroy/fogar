import { LocalProvider } from '@/lib/llm/local';
import { CloudProvider } from '@/lib/llm/cloud';
import { MODELS, modelById } from '@/lib/llm/models';
import type { Message, Mode, Provider, Settings } from '@/lib/llm/types';
import { ensureEndpointPermission, loadSettings, saveSettings } from '@/lib/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const body = document.body;
const params = new URLSearchParams(location.search);
const SMOKE = params.get('smoke') === '1';
const INITIAL_QUESTION = params.get('q');
const SEARCH_URL = 'https://duckduckgo.com/?q=';

const SYSTEM_PROMPT =
  'You are Fogar, a concise assistant running in the user\'s browser. Answer directly, in plain language, in a few sentences unless asked for more.';

// Rotating footer line. Own products first; a disclosed sponsor slot comes later, and only with real usage.
const PROMO: Array<[label: string, href: string]> = [
  ['UseSQL: run SQL across Google Sheets, APIs and files', 'https://www.usesql.com/?ref=fogar'],
  ['TickerPal: stock prices on demand in Slack', 'https://tickerpal.com/?ref=fogar'],
  ['Kumkuat: know how every audience reacts before you say a word', 'https://kumkuat.ai/?ref=fogar'],
  ['Read how Fogar was built', 'https://dylanroy.com/?ref=fogar'],
];

let settings: Settings;
const local = new LocalProvider();
let abort: AbortController | null = null;

function setStatus(text: string) { $('status').textContent = text; }
function setMode(mode: Mode) {
  settings.mode = mode;
  $('mode-local').setAttribute('aria-checked', String(mode === 'local'));
  $('mode-cloud').setAttribute('aria-checked', String(mode === 'cloud'));
  $('local-settings').hidden = mode !== 'local';
  $('cloud-settings').hidden = mode !== 'cloud';
  refreshReadiness();
  void saveSettings(settings);
}
function refreshReadiness() {
  const ready = settings.mode === 'cloud' ? Boolean(settings.cloud.endpoint && settings.cloud.model) : local.loaded !== null;
  ($('ask-btn') as HTMLButtonElement).disabled = !ready;
  $('web-search').hidden = ready;
  if (settings.mode === 'local') {
    setStatus(local.loaded ? `Ready · ${local.loaded.label} · ${settings.gpu && LocalProvider.hasWebGPU() ? 'WebGPU' : 'CPU'}` : 'No model loaded. Open Settings to download one.');
  } else {
    setStatus(ready ? `Ready · ${settings.cloud.model} via ${new URL(settings.cloud.endpoint).host}` : 'Add a cloud endpoint in Settings.');
  }
}

let loading = false;
async function loadModel() {
  // A second click mid-download used to tear down the first wllama instance while its OPFS writer still held the
  // file open; the retry then failed on removeEntry. One load at a time.
  if (loading) return;
  loading = true;
  const loadBtn = $('load-btn') as HTMLButtonElement;
  loadBtn.disabled = true;
  const spec = modelById(settings.modelId);
  const progress = $('progress'); const bar = $('progress-bar'); const text = $('progress-text');
  progress.hidden = false; body.dataset.status = 'loading';
  const t0 = performance.now();
  setStatus(`Loading ${spec.label}…`);
  try {
    await local.load(spec, {
      gpu: settings.gpu && LocalProvider.hasWebGPU(),
      onProgress: (f, loaded, total) => {
        bar.style.width = `${Math.round(f * 100)}%`;
        text.textContent = total ? `${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB` : 'Preparing…';
      },
    });
    const ms = Math.round(performance.now() - t0);
    $('stats').hidden = false;
    $('stats').textContent = `Model ready in ${ms} ms`;
    body.dataset.status = 'ready';
    settings.autoLoad = true;
    void saveSettings(settings);
    void refreshCacheLine();
  } catch (err) {
    body.dataset.status = 'error';
    setStatus(`Load failed: ${(err as Error).message}`);
    console.error('[fogar] load failed', err);
    return;
  } finally {
    progress.hidden = true;
    loading = false;
    loadBtn.disabled = false;
  }
  refreshReadiness();
}

async function ask(prompt: string) {
  abort?.abort();
  abort = new AbortController();
  const provider: Provider = settings.mode === 'cloud' ? new CloudProvider(settings.cloud) : local;
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }];
  const answer = $('answer'); answer.hidden = false; answer.textContent = '';
  body.dataset.status = 'answering';
  $('stop-btn').hidden = false; ($('ask-btn') as HTMLButtonElement).disabled = true;
  const t0 = performance.now(); let tokens = 0; let firstAt = 0;
  try {
    for await (const token of provider.ask(messages, abort.signal)) {
      if (!firstAt) firstAt = performance.now();
      tokens++;
      answer.textContent += token;
    }
    const total = performance.now() - t0;
    $('stats').hidden = false;
    $('stats').textContent = `${tokens} tokens · first token ${Math.round(firstAt - t0)} ms · ${(tokens / ((total - (firstAt - t0)) / 1000)).toFixed(1)} tok/s`;
    body.dataset.status = 'done';
  } catch (err) {
    if (abort.signal.aborted) {
      body.dataset.status = 'done';
    } else {
      body.dataset.status = 'error';
      answer.textContent = `Error: ${(err as Error).message}`;
      console.error('[fogar] ask failed', err);
    }
  } finally {
    $('stop-btn').hidden = true;
    refreshReadiness();
  }
}

async function refreshCacheLine() {
  const bytes = await LocalProvider.cacheSize();
  $('cache-line').textContent = bytes ? `Cached models: ${(bytes / 1e6).toFixed(0)} MB` : 'Cached models: none';
}

function webSearch(query: string) {
  location.href = SEARCH_URL + encodeURIComponent(query);
}

async function init() {
  settings = await loadSettings();
  if (SMOKE) {
    settings.mode = 'local'; settings.modelId = params.get('model') ?? 'smoke'; settings.gpu = params.get('gpu') === '1';
    const cloudPort = params.get('cloud');
    if (cloudPort) { settings.mode = 'cloud'; settings.cloud = { endpoint: `http://127.0.0.1:${cloudPort}/v1`, apiKey: 'test-key', model: 'mock-model' }; }
  }

  const modelSel = $('model') as HTMLSelectElement;
  for (const m of MODELS) modelSel.add(new Option(`${m.label} · ~${m.approxMB} MB`, m.id));
  modelSel.value = settings.modelId;
  $('model-note').textContent = modelById(settings.modelId).note;
  modelSel.onchange = () => { settings.modelId = modelSel.value; $('model-note').textContent = modelById(settings.modelId).note; void saveSettings(settings); };

  const gpu = $('gpu') as HTMLInputElement;
  gpu.checked = settings.gpu; gpu.disabled = !LocalProvider.hasWebGPU();
  $('gpu-note').textContent = LocalProvider.hasWebGPU() ? '' : '(not available in this browser)';
  gpu.onchange = () => { settings.gpu = gpu.checked; void saveSettings(settings); };
  $('load-btn').onclick = () => void loadModel();

  ($('cloud-endpoint') as HTMLInputElement).value = settings.cloud.endpoint;
  ($('cloud-key') as HTMLInputElement).value = settings.cloud.apiKey;
  ($('cloud-model') as HTMLInputElement).value = settings.cloud.model;
  $('cloud-save').onclick = async () => {
    settings.cloud = {
      endpoint: ($('cloud-endpoint') as HTMLInputElement).value.trim(),
      apiKey: ($('cloud-key') as HTMLInputElement).value.trim(),
      model: ($('cloud-model') as HTMLInputElement).value.trim(),
    };
    const ok = await ensureEndpointPermission(settings.cloud.endpoint);
    await saveSettings(settings);
    setMode('cloud');
    if (!ok) setStatus('Permission for that endpoint was not granted.');
  };

  $('mode-local').onclick = () => setMode('local');
  $('mode-cloud').onclick = () => setMode('cloud');
  $('ask-form').onsubmit = (e) => {
    e.preventDefault();
    const p = ($('prompt') as HTMLTextAreaElement).value.trim();
    if (!p) return;
    // Before a model is ready the box still does something useful: a plain web search.
    if (($('ask-btn') as HTMLButtonElement).disabled && body.dataset.status !== 'answering') webSearch(p);
    else void ask(p);
  };
  $('web-search').onclick = (e) => { e.preventDefault(); const p = ($('prompt') as HTMLTextAreaElement).value.trim(); if (p) webSearch(p); };
  $('stop-btn').onclick = () => abort?.abort();
  $('clear-cache').onclick = async (e) => {
    e.preventDefault();
    await local.unload();
    await LocalProvider.clearCache();
    settings.autoLoad = false; await saveSettings(settings);
    await refreshCacheLine(); refreshReadiness();
  };
  void refreshCacheLine();
  $('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('ask-form').dispatchEvent(new Event('submit')); } });

  const [label, href] = PROMO[Math.floor(Math.random() * PROMO.length)]!;
  $('promo').innerHTML = `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;

  setMode(settings.mode);
  if (INITIAL_QUESTION) ($('prompt') as HTMLTextAreaElement).value = `Explain this: “${INITIAL_QUESTION}”`;

  if (SMOKE) {
    if (settings.mode === 'cloud') { await ask('Say hello'); return; }
    await loadModel(); if (local.loaded) await ask('Once upon a time'); return;
  }
  // New tab after the first successful load: bring the cached model up without a click.
  if (settings.mode === 'local' && settings.autoLoad) await loadModel();
  if (INITIAL_QUESTION && !($('ask-btn') as HTMLButtonElement).disabled) void ask(($('prompt') as HTMLTextAreaElement).value);
}

void init();

import type { App } from '@/entrypoints/newtab/app';
import { CloudProvider } from './llm/cloud';
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_ENDPOINT, AnthropicProvider, anthropicListModels } from './llm/anthropic';
import type { Provider } from './llm/types';
import { getItem, setItem, uid } from './store';

/**
 * A model profile is a place to send a conversation: an OpenAI-compatible endpoint or Anthropic's Messages API,
 * with the key that goes with it. Profiles are shared by every chat widget; each widget picks one. The two
 * built-ins are what the ask bar already uses: the model on this device and the cloud endpoint from Settings.
 */
export type ModelKind = 'openai' | 'anthropic';

export interface ModelProfile {
  id: string;
  name: string;
  kind: ModelKind;
  endpoint: string;
  apiKey: string;
  model: string;
  /** The model reads images, so the Notebook can hand it a photo. */
  vision?: boolean;
}

export interface Preset { id: string; name: string; kind: ModelKind; endpoint: string; model: string; note: string; vision: boolean; keyless?: boolean }

export const PRESETS: Preset[] = [
  { id: 'anthropic', name: 'Anthropic (Claude)', kind: 'anthropic', endpoint: ANTHROPIC_ENDPOINT, model: ANTHROPIC_DEFAULT_MODEL, note: 'Key from console.anthropic.com. Reads images.', vision: true },
  { id: 'openai', name: 'OpenAI', kind: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', note: 'Key from platform.openai.com. Reads images.', vision: true },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', endpoint: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5', note: 'One key, hundreds of models. Pick a vision model to read photos.', vision: true },
  { id: 'gemini', name: 'Google Gemini', kind: 'openai', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', note: 'Key from aistudio.google.com, through the OpenAI-compatible endpoint. Reads images.', vision: true },
  { id: 'groq', name: 'Groq', kind: 'openai', endpoint: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', note: 'Very fast open models.', vision: false },
  { id: 'ollama', name: 'Ollama (this computer)', kind: 'openai', endpoint: 'http://localhost:11434/v1', model: 'llama3.2', note: 'No key. Pull a vision model such as llava or qwen2.5vl to read photos.', vision: false, keyless: true },
  { id: 'lmstudio', name: 'LM Studio (this computer)', kind: 'openai', endpoint: 'http://localhost:1234/v1', model: '', note: 'No key. Fetch models to see what is loaded.', vision: false, keyless: true },
  { id: 'custom', name: 'Custom OpenAI-compatible', kind: 'openai', endpoint: '', model: '', note: 'Any /v1/chat/completions server.', vision: false },
];

export const MODELS_KEY = 'fogar.chat.models';
export const loadProfiles = () => getItem<ModelProfile[]>(MODELS_KEY, []);
export const saveProfiles = (p: ModelProfile[]) => setItem(MODELS_KEY, p);

export function newProfile(preset: Preset): ModelProfile {
  return { id: uid(), name: preset.name, kind: preset.kind, endpoint: preset.endpoint, apiKey: '', model: preset.model, vision: preset.vision };
}

/** A key is optional for servers on this machine. */
export const profileReady = (p: ModelProfile) => Boolean(p.endpoint && p.model && (p.apiKey || /localhost|127\.0\.0\.1/.test(p.endpoint)));

export type ChoiceId = 'fogar-local' | 'fogar-cloud' | string;
export interface Choice { id: ChoiceId; name: string; ready: boolean; note?: string; vision?: boolean }

/** Everything a chat can talk to: the two built-ins, then the saved profiles. */
export function choices(app: App, profiles: ModelProfile[]): Choice[] {
  const s = app.settings;
  const localName = app.local.loaded?.label.replace(/^\w+: /, '') ?? 'the model on this device';
  return [
    { id: 'fogar-local', name: `This device · ${localName}`, ready: app.settings.onboarded && (app.local.loaded !== null || app.settings.autoLoad), note: 'Private. Nothing leaves this browser.' },
    { id: 'fogar-cloud', name: `Fogar cloud · ${s.cloud.model || 'not set up'}`, ready: app.cloudConfigured(), note: 'The endpoint from Settings.' },
    ...profiles.map((p) => ({ id: p.id, name: `${p.name} · ${p.model || 'no model'}`, ready: profileReady(p), vision: p.vision })),
  ];
}

export function providerFor(id: ChoiceId, app: App, profiles: ModelProfile[]): Provider | null {
  if (id === 'fogar-local') return app.local;
  if (id === 'fogar-cloud') return app.cloudConfigured() ? new CloudProvider(app.settings.cloud) : null;
  const p = profiles.find((x) => x.id === id);
  if (!p || !profileReady(p)) return null;
  return p.kind === 'anthropic' ? new AnthropicProvider(p) : new CloudProvider(p);
}

/** Ask an endpoint what it serves: /v1/models for OpenAI-compatible servers (Ollama answers there too), /v1/models for Anthropic. */
export async function listModels(p: ModelProfile, signal?: AbortSignal): Promise<string[]> {
  if (p.kind === 'anthropic') return anthropicListModels(p, signal);
  const base = p.endpoint.replace(/\/+$/, '');
  const res = await fetch(`${base}/models`, { signal, headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {} });
  if (!res.ok) throw new Error(`The endpoint returned ${res.status}`);
  const data = await res.json();
  const ids = ((data?.data ?? data?.models ?? []) as Array<{ id?: string; name?: string }>).map((m) => m.id ?? m.name ?? '').filter(Boolean);
  return [...new Set(ids)]; // the endpoint's own order: Ollama lists what is installed, OpenAI newest first
}

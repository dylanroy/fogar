import type { AskOpts, Message, Provider } from './types';

export interface AnthropicSettings {
  /** API origin, normally https://api.anthropic.com. */
  endpoint: string;
  apiKey: string;
  model: string;
}

export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5';
const VERSION = '2023-06-01';

/** The headers every Messages API call carries. The browser-access header is what lets a page call the API directly. */
export const anthropicHeaders = (apiKey: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  'x-api-key': apiKey,
  'anthropic-version': VERSION,
  'anthropic-dangerous-direct-browser-access': 'true',
});

/** Anthropic wants one system string and strictly alternating user/assistant turns that start with the user. */
export function anthropicTurns(messages: Message[]): { system: string; turns: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else turns.push({ role: m.role, content: m.content });
  }
  while (turns.length && turns[0]!.role !== 'user') turns.shift();
  if (!turns.length) turns.push({ role: 'user', content: '' });
  return { system, turns };
}

/**
 * Claude through the Messages API, streamed over SSE. Text deltas are yielded; the key goes only to the endpoint
 * the profile names. A safety refusal with no text is reported as an error the widget can show.
 */
export class AnthropicProvider implements Provider {
  constructor(private settings: AnthropicSettings) {}

  async *ask(messages: Message[], signal: AbortSignal, opts: AskOpts = {}): AsyncIterable<string> {
    const base = (this.settings.endpoint || ANTHROPIC_ENDPOINT).replace(/\/+$/, '').replace(/\/v1$/, '');
    const { system, turns } = anthropicTurns(messages);
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST', signal,
      headers: anthropicHeaders(this.settings.apiKey),
      body: JSON.stringify({
        model: this.settings.model, max_tokens: opts.maxTokens ?? 4096, stream: true,
        ...(system ? { system } : {}), messages: turns,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      }),
    });
    if (!res.ok || !res.body) {
      let detail = '';
      try { detail = (await res.json())?.error?.message ?? ''; } catch { /* no body */ }
      throw new Error(`Anthropic returned ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; let event = ''; let yielded = false; let refusal: string | null = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
        if (!line.startsWith('data:')) continue;
        let data: any;
        try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
        const type = data?.type ?? event;
        if (type === 'content_block_delta') {
          const text = data.delta?.type === 'text_delta' ? data.delta.text : undefined;
          if (text) { yielded = true; yield text; }
        } else if (type === 'message_delta') {
          if (data.delta?.stop_reason === 'refusal') refusal = data.delta?.stop_details?.category ?? data.stop_details?.category ?? 'safety';
        } else if (type === 'error') {
          throw new Error(data.error?.message ?? 'Anthropic returned an error mid-stream.');
        } else if (type === 'message_stop') {
          if (refusal && !yielded) throw new Error(`The model declined this request (${refusal}).`);
          return;
        }
      }
    }
    if (refusal && !yielded) throw new Error(`The model declined this request (${refusal}).`);
  }
}

/** The models the key can use, newest first as the API lists them. */
export async function anthropicListModels(s: AnthropicSettings, signal?: AbortSignal): Promise<string[]> {
  const base = (s.endpoint || ANTHROPIC_ENDPOINT).replace(/\/+$/, '').replace(/\/v1$/, '');
  const res = await fetch(`${base}/v1/models?limit=100`, { headers: anthropicHeaders(s.apiKey), signal });
  if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
  const data = await res.json();
  return ((data?.data ?? []) as Array<{ id: string }>).map((m) => m.id);
}

import type { CloudSettings, Message, Provider } from './types';

/** Any OpenAI-compatible /chat/completions endpoint, streamed over SSE. Key never leaves the browser except to that endpoint. */
export class CloudProvider implements Provider {
  constructor(private settings: CloudSettings) {}

  async *ask(messages: Message[], signal: AbortSignal): AsyncIterable<string> {
    const base = this.settings.endpoint.replace(/\/+$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.settings.model, messages, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`Cloud endpoint returned ${res.status} ${res.statusText}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const token = JSON.parse(data)?.choices?.[0]?.delta?.content;
          if (token) yield token;
        } catch { /* partial line, ignore */ }
      }
    }
  }
}

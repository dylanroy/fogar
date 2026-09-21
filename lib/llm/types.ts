export type Role = 'system' | 'user' | 'assistant';
export interface Message { role: Role; content: string }

export interface Provider {
  /** Stream answer tokens for a conversation. */
  ask(messages: Message[], signal: AbortSignal): AsyncIterable<string>;
}

export type Mode = 'local' | 'cloud';

export interface CloudSettings {
  endpoint: string; // OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or http://localhost:11434/v1
  apiKey: string;
  model: string;
}

export interface Settings {
  mode: Mode;
  modelId: string;
  gpu: boolean;
  cloud: CloudSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'local',
  modelId: 'qwen3-0.6b',
  gpu: true,
  cloud: { endpoint: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
};

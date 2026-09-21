export type Role = 'system' | 'user' | 'assistant';
export interface Message { role: Role; content: string }

export interface AskOpts { maxTokens?: number }
export interface Provider {
  /** Stream answer tokens for a conversation. */
  ask(messages: Message[], signal: AbortSignal, opts?: AskOpts): AsyncIterable<string>;
}

export type Mode = 'local' | 'cloud';

export interface CloudSettings {
  endpoint: string; // OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or http://localhost:11434/v1
  apiKey: string;
  model: string;
}

export type GroundingProvider = 'none' | 'brave' | 'tavily';
export interface GroundingSettings {
  provider: GroundingProvider;
  apiKey: string;
  /** Search the web before answering unless the user unticks it for a question. */
  byDefault: boolean;
  /** Test hook: override the provider URL. Not exposed in the UI. */
  endpoint?: string;
}

export interface Settings {
  mode: Mode;
  modelId: string;
  gpu: boolean;
  /** Set after the first successful local load; new tabs then load the cached model without a click. */
  autoLoad: boolean;
  /** First-run screen has been answered. */
  onboarded: boolean;
  cloud: CloudSettings;
  grounding: GroundingSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'local',
  modelId: 'qwen3.5-0.8b',
  gpu: true,
  autoLoad: false,
  onboarded: false,
  cloud: { endpoint: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  grounding: { provider: 'none', apiKey: '', byDefault: true },
};

export const SYSTEM_PROMPT =
  "You are Fogar, a concise assistant running in the user's browser. Answer directly, in plain language, in a few sentences unless asked for more.";

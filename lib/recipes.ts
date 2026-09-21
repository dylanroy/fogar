import type { Message } from './llm/types';
import { getItem, setItem, uid } from './store';

/**
 * A recipe is a small form in front of a prompt. Recipes are data, never code, so users can
 * make and share them without the extension running anything it did not ship with.
 */
export type RecipeInputType = 'text' | 'textarea' | 'select';
export interface RecipeInput {
  key: string;
  label: string;
  type: RecipeInputType;
  options?: string[];
  default?: string;
  placeholder?: string;
}
export interface Recipe {
  version: 1;
  id: string;
  name: string;
  description: string;
  emoji?: string;
  inputs: RecipeInput[];
  /** Optional system prompt; the default Fogar prompt is used otherwise. */
  system?: string;
  /** User prompt with {{key}} placeholders. */
  template: string;
  builtin?: boolean;
}

const TONES = ['Neutral', 'Friendly', 'Formal', 'Direct', 'Playful'];

export const BUILTIN_RECIPES: Recipe[] = [
  {
    version: 1, id: 'rewrite', builtin: true, emoji: '✍️',
    name: 'Draft & rewrite',
    description: 'Paste a rough draft or a few notes. Get it back in the tone, length, and shape you want.',
    inputs: [
      { key: 'text', label: 'Your text or notes', type: 'textarea', placeholder: 'Paste what you have, or describe what you need to say.' },
      { key: 'tone', label: 'Tone', type: 'select', options: TONES, default: 'Neutral' },
      { key: 'length', label: 'Length', type: 'select', options: ['Shorter', 'About the same', 'Longer'], default: 'About the same' },
      { key: 'format', label: 'Format', type: 'select', options: ['Keep as is', 'Email', 'Bullet points', 'One sentence', 'Chat message'], default: 'Keep as is' },
    ],
    system: 'You are a careful writing assistant. Return only the rewritten text, with no preamble and no commentary.',
    template: 'Rewrite the text below.\nTone: {{tone}}. Length: {{length}}. Format: {{format}}.\nKeep the meaning and any specific facts, names, and numbers.\n\nText:\n{{text}}',
  },
  {
    version: 1, id: 'reply', builtin: true, emoji: '↩️',
    name: 'Reply to a message',
    description: 'Paste the message you received and say what you want to happen. Get a reply you can send.',
    inputs: [
      { key: 'message', label: 'The message you received', type: 'textarea', placeholder: 'Paste the email or chat message here.' },
      { key: 'intent', label: 'What do you want to say?', type: 'text', placeholder: 'e.g. decline politely, ask for a week more, say yes and propose Tuesday' },
      { key: 'tone', label: 'Tone', type: 'select', options: TONES, default: 'Friendly' },
    ],
    system: 'You draft replies on behalf of the user. Return only the reply text, ready to send, with no preamble.',
    template: 'Write a reply to this message. The user wants to: {{intent}}. Tone: {{tone}}.\n\nMessage:\n{{message}}',
  },
  {
    version: 1, id: 'summarize', builtin: true, emoji: '🧾',
    name: 'Summarize',
    description: 'Long thing in, short thing out.',
    inputs: [
      { key: 'text', label: 'Text', type: 'textarea', placeholder: 'Paste an article, a thread, meeting notes…' },
      { key: 'style', label: 'Style', type: 'select', options: ['Three bullets', 'One paragraph', 'One sentence', 'Key decisions and action items'], default: 'Three bullets' },
    ],
    template: 'Summarize the text below as: {{style}}. Be specific; keep names and numbers.\n\nText:\n{{text}}',
  },
  {
    version: 1, id: 'explain', builtin: true, emoji: '💡',
    name: 'Explain simply',
    description: 'Make something make sense.',
    inputs: [
      { key: 'text', label: 'What to explain', type: 'textarea', placeholder: 'A paragraph, a term, an error message…' },
      { key: 'audience', label: 'For', type: 'select', options: ['A smart friend', 'A ten-year-old', 'An expert in another field', 'Me, in one sentence'], default: 'A smart friend' },
    ],
    template: 'Explain the following for {{audience}}. Use plain words and one concrete example if it helps.\n\n{{text}}',
  },
];

const KEY = 'fogar.recipes';
export const loadUserRecipes = () => getItem<Recipe[]>(KEY, []);
export const saveUserRecipes = (r: Recipe[]) => setItem(KEY, r);

export async function allRecipes(): Promise<Recipe[]> {
  return [...BUILTIN_RECIPES, ...(await loadUserRecipes())];
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k: string) => values[k] ?? '');
}

export function recipeMessages(recipe: Recipe, values: Record<string, string>, defaultSystem: string): Message[] {
  return [
    { role: 'system', content: recipe.system?.trim() || defaultSystem },
    { role: 'user', content: fillTemplate(recipe.template, values) },
  ];
}

export function newRecipe(): Recipe {
  return { version: 1, id: uid(), name: '', description: '', emoji: '🧪', inputs: [{ key: 'text', label: 'Text', type: 'textarea' }], template: '{{text}}' };
}

/** Accept anything shaped like a recipe from a paste or a share link; reject the rest. */
export function validateRecipe(raw: unknown): Recipe | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || typeof r.template !== 'string' || !Array.isArray(r.inputs)) return null;
  const inputs: RecipeInput[] = [];
  for (const i of r.inputs as unknown[]) {
    if (!i || typeof i !== 'object') return null;
    const o = i as Record<string, unknown>;
    if (typeof o.key !== 'string' || !/^[a-zA-Z0-9_]+$/.test(o.key) || typeof o.label !== 'string') return null;
    const type = (['text', 'textarea', 'select'] as const).includes(o.type as RecipeInputType) ? (o.type as RecipeInputType) : 'text';
    inputs.push({
      key: o.key, label: o.label, type,
      options: Array.isArray(o.options) ? (o.options as unknown[]).map(String).slice(0, 20) : undefined,
      default: typeof o.default === 'string' ? o.default : undefined,
      placeholder: typeof o.placeholder === 'string' ? o.placeholder : undefined,
    });
  }
  return {
    version: 1,
    id: typeof r.id === 'string' && r.id ? r.id : uid(),
    name: r.name.slice(0, 60),
    description: typeof r.description === 'string' ? r.description.slice(0, 200) : '',
    emoji: typeof r.emoji === 'string' ? r.emoji.slice(0, 4) : '🧪',
    inputs: inputs.slice(0, 8),
    system: typeof r.system === 'string' ? r.system.slice(0, 2000) : undefined,
    template: r.template.slice(0, 4000),
  };
}

const b64url = {
  enc: (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))),
};

export function encodeRecipeShare(recipe: Recipe): string {
  const { builtin, ...rest } = recipe;
  return b64url.enc(JSON.stringify(rest));
}

export function decodeRecipeShare(encoded: string): Recipe | null {
  try { return validateRecipe(JSON.parse(b64url.dec(encoded))); } catch { return null; }
}

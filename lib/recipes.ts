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
    system: 'You are a careful writing assistant. You rewrite the user\'s own words; you never reply to them. Return only the rewritten text, with no preamble and no commentary.',
    template: 'Rewrite the text below so it says the same thing, better.\nTone: {{tone}}. Length: {{length}}. Format: {{format}}.\nKeep the meaning and any specific facts, names, and numbers. Do not answer or respond to the text; rewrite it.\n\nExample:\nText: cant come tmrw, sick\nRewritten: I\'m sorry, I won\'t be able to come tomorrow. I\'m not feeling well.\n\nText: {{text}}\nRewritten:',
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

const humanize = (key: string) => key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const LONG_KEYS = /^(text|message|notes?|content|body|draft|input|source|email|paragraphs?|article)$/i;

/**
 * Accept anything shaped like a recipe from a paste or a share link. Only a name and a template are required:
 * missing labels come from the key, missing inputs come from the {{placeholders}} in the template, and a
 * missing type is a textarea for keys that sound like prose and a text field otherwise.
 */
export function validateRecipe(raw: unknown): Recipe | null {
  return checkRecipe(raw).recipe;
}

export function checkRecipe(raw: unknown): { recipe: Recipe | null; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { recipe: null, error: 'A recipe is a JSON object with at least a "name" and a "template".' };
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !r.name.trim()) return { recipe: null, error: 'The recipe needs a "name".' };
  if (typeof r.template !== 'string' || !r.template.trim()) return { recipe: null, error: 'The recipe needs a "template" string with the prompt.' };
  const template = r.template.slice(0, 4000);
  const inputs: RecipeInput[] = [];
  const seen = new Set<string>();
  const rawInputs = Array.isArray(r.inputs) ? (r.inputs as unknown[]) : [];
  for (const [idx, i] of rawInputs.entries()) {
    if (!i || typeof i !== 'object') return { recipe: null, error: `inputs[${idx}] should be an object like { "key": "text", "type": "textarea" }.` };
    const o = i as Record<string, unknown>;
    const key = typeof o.key === 'string' ? o.key.trim() : '';
    if (!/^[a-zA-Z0-9_]+$/.test(key)) return { recipe: null, error: `inputs[${idx}] needs a "key" made of letters, digits, or underscores.` };
    if (seen.has(key)) continue;
    seen.add(key);
    const type = (['text', 'textarea', 'select'] as const).includes(o.type as RecipeInputType) ? (o.type as RecipeInputType) : LONG_KEYS.test(key) ? 'textarea' : 'text';
    const options = Array.isArray(o.options) ? (o.options as unknown[]).map(String).filter(Boolean).slice(0, 20) : undefined;
    inputs.push({
      key, type: type === 'select' && !options?.length ? 'text' : type,
      label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : humanize(key),
      options: type === 'select' ? options : undefined,
      default: typeof o.default === 'string' ? o.default : undefined,
      placeholder: typeof o.placeholder === 'string' ? o.placeholder : undefined,
    });
  }
  // Placeholders used in the template but never declared become inputs too.
  for (const m of template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const key = m[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    inputs.push({ key, label: humanize(key), type: LONG_KEYS.test(key) ? 'textarea' : 'text' });
  }
  if (!inputs.length) return { recipe: null, error: 'The template has no {{placeholders}} and no inputs, so there would be nothing to fill in.' };
  return {
    recipe: {
      version: 1,
      id: typeof r.id === 'string' && r.id ? r.id : uid(),
      name: r.name.trim().slice(0, 60),
      description: typeof r.description === 'string' ? r.description.slice(0, 200) : '',
      emoji: typeof r.emoji === 'string' && r.emoji.trim() ? r.emoji.trim().slice(0, 4) : '🧪',
      inputs: inputs.slice(0, 8),
      system: typeof r.system === 'string' ? r.system.slice(0, 2000) : undefined,
      template,
    },
  };
}

/** Escape raw line breaks and tabs that sit inside JSON string literals, which is the usual copy-paste damage. */
function escapeNewlinesInStrings(text: string): string {
  let out = ''; let inString = false; let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch; continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/**
 * Turn whatever was pasted into a recipe: JSON (also with smart quotes, trailing commas, raw line breaks inside
 * strings, or wrapped in a code fence), a share link, or a bare share token. Says what is wrong otherwise.
 */
export function parseRecipeText(input: string): { recipe: Recipe | null; error?: string } {
  let text = input.trim();
  if (!text) return { recipe: null, error: 'Paste a recipe first.' };
  const link = text.match(/[?&]recipe=([A-Za-z0-9_-]+)/);
  if (link) { const r = decodeRecipeShare(link[1]!); return r ? { recipe: r } : { recipe: null, error: 'That share link does not contain a valid recipe.' }; }
  if (/^[A-Za-z0-9_-]{40,}$/.test(text)) { const r = decodeRecipeShare(text); if (r) return { recipe: r }; }
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  const attempts = [text, escapeNewlinesInStrings(text), escapeNewlinesInStrings(text).replace(/,(\s*[}\]])/g, '$1')];
  let lastError = '';
  for (const candidate of attempts) {
    try { return checkRecipe(JSON.parse(candidate)); } catch (err) { lastError = (err as Error).message; }
  }
  return { recipe: null, error: `That is not valid JSON: ${lastError.replace(/^JSON\.parse: /, '').replace(/ in JSON at position \d+.*$/, '')}.` };
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

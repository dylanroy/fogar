import type { Message } from './llm/types';
import { uid } from './store';

/**
 * Voice: the data and the prompts behind the Writing widget. One author's voice is distilled once from samples
 * of their real writing into a profile that rides along on every run. Registers are modes under that voice
 * (email, chat, essay: same person, different formality and length), never separate voices; a profile per
 * surface would need three times the samples and drift until they stop sounding like one person. Everything
 * here is text and data; the widget owns the DOM and the model calls.
 */
export interface Register {
  id: string;
  name: string;
  formality: string;
  length: string;
  /** Rules followed exactly, e.g. "no em dashes; sign off with my first name". */
  notes: string;
}
export interface Sample {
  id: string; text: string; /** Where it came from: email, slack, post… */ source: string; addedAt: number;
  /** Changed after it was added; 0 if never. A profile built before this is out of date. */
  editedAt: number;
  /** Read when distilling. Off keeps a sample without letting it shape the voice, or makes room in the local window. */
  use: boolean;
}
export interface VoiceProfile {
  text: string; version: number; builtAt: number; samples: number; model: string;
  /** The samples in use when it was distilled, to tell what changed since; null for a profile from before this was kept. */
  basis: string[] | null;
  /** Changed by hand since it was distilled. */
  edited: boolean;
}
/** A one-line correction ("I never say 'reach out'") that rides along on every run and outlasts every distill. */
export interface Amendment { id: string; text: string; at: number }
export type Op = 'rewrite' | 'tighten' | 'warmer' | 'draft';
export interface Output { text: string; op: Op; register: string; version: number | null; model: string; at: number }
export interface VoiceData {
  version: 1;
  samples: Sample[];
  profile: VoiceProfile | null;
  /** Earlier profiles, newest first: distilling again, or restoring one, never throws a version away. */
  history: VoiceProfile[];
  amendments: Amendment[];
  registers: Register[];
  /** The register in use; empty for the plain voice with no register constraints. */
  registerId: string;
  op: Op;
  input: string;
  instruction: string;
  output: Output | null;
}

/** The three registers everyone starts with. Surface picks a register; the voice stays one voice. */
export const DEFAULT_REGISTERS: ReadonlyArray<Omit<Register, 'id'>> = [
  { name: 'Email', formality: 'professional but warm', length: 'concise; a few short paragraphs, no padding', notes: 'open with the point, not throat-clearing; sign off naturally' },
  { name: 'Chat', formality: 'casual, conversational', length: 'terse; one to a few lines, often a single thought', notes: 'lowercase is fine, fragments are fine, no formal sign-off, no bullet lists' },
  { name: 'Essay', formality: 'considered, literary', length: 'flowing long-form; let paragraphs breathe and arguments develop', notes: 'build an argument; vary rhythm hard; specific detail over generality' },
];

export const OPS: ReadonlyArray<{ id: Op; label: string; hint: string }> = [
  { id: 'rewrite', label: 'Rewrite', hint: 'Same meaning, about the same length, in your voice.' },
  { id: 'tighten', label: 'Tighten', hint: 'Cut the padding. Every point stays; nothing gets longer.' },
  { id: 'warmer', label: 'Warmer', hint: 'More personal, without turning saccharine or adding anything.' },
  { id: 'draft', label: 'Draft', hint: 'New text from a brief, or a reply to what you paste.' },
];

const OP_GUIDANCE: Record<Op, string> = {
  rewrite: 'Rewrite the source material in the author\'s voice, preserving its meaning, intent, AND approximate length. Do NOT add new points, steps, explanations, or information that is not in the source. A short blunt message becomes a short message in their voice: never an essay, a list, or a troubleshooting guide.',
  tighten: 'Cut the source material down, removing padding and redundancy, while keeping the author\'s voice and every load-bearing point. Never make it longer.',
  warmer: 'Make the source material warmer and more personal in the author\'s voice, without turning saccharine, padding it, or adding new information.',
  draft: 'Write NEW text in the author\'s voice: a reply, or a fresh message. Treat the source material as CONTEXT to respond to (an email thread, a chat message), NOT as text to edit: do not echo, quote, or rewrite it. The user\'s instruction sets the intent, what the message should say or do. With no source material, treat the instruction as a standalone brief and write from scratch.',
};

/** Characters of writing samples one distill call carries. The local window is 4,096 tokens shared with the profile it writes. */
export const SAMPLE_BUDGET = { local: 5500, cloud: 30000 } as const;
/** Characters of source text one run carries; the local window also holds the profile and the answer. */
export const TEXT_BUDGET = { local: 6500, cloud: 40000 } as const;
/** How long the distilled profile may run: it rides along on every run, so the local window has to hold it. */
export const PROFILE_WORDS = { local: 300, cloud: 700 } as const;
/** The answer's room. A rewrite is about as long as its source; a draft rarely needs more. */
export const OUTPUT_TOKENS = { local: 700, cloud: 2000 } as const;
/** The profile as sent on a local run, so a hand-edited epic cannot crowd out the text. */
export const LOCAL_PROFILE_CHARS = 3000;
/** The same for the corrections on a local run. */
export const LOCAL_AMENDMENT_CHARS = 1200;
export const MAX_AMENDMENTS = 30;
export const AMENDMENT_MAX = 300;
/** Earlier profiles kept for restoring. */
export const HISTORY_MAX = 5;

export const newRegister = (r: Partial<Omit<Register, 'id'>> = {}): Register => ({ id: uid(), name: '', formality: '', length: '', notes: '', ...r });

export function newVoiceData(): VoiceData {
  const registers = DEFAULT_REGISTERS.map((r) => newRegister(r));
  return { version: 1, samples: [], profile: null, history: [], amendments: [], registers, registerId: registers[0]!.id, op: 'rewrite', input: '', instruction: '', output: null };
}

/** Whatever storage holds, as a usable VoiceData: missing parts get defaults, and an old shape never crashes the widget. */
export function normalizeVoiceData(raw: unknown): VoiceData {
  const fresh = newVoiceData();
  if (!raw || typeof raw !== 'object') return fresh;
  const r = raw as Partial<VoiceData>;
  const registers: Register[] = Array.isArray(r.registers)
    ? r.registers.filter((x) => x && typeof x.name === 'string').map((x) => ({ id: String(x.id || uid()), name: x.name, formality: String(x.formality ?? ''), length: String(x.length ?? ''), notes: String(x.notes ?? '') }))
    : fresh.registers;
  const samples: Sample[] = Array.isArray(r.samples)
    ? r.samples.filter((s) => s && typeof s.text === 'string' && s.text.trim()).map((s) => ({ id: String(s.id || uid()), text: s.text, source: String(s.source ?? ''), addedAt: Number(s.addedAt) || Date.now(), editedAt: Number(s.editedAt) || 0, use: s.use !== false }))
    : [];
  const toProfile = (p: Partial<VoiceProfile> | null | undefined): VoiceProfile | null => p && typeof p.text === 'string' && p.text.trim()
    ? { text: p.text, version: Number(p.version) || 1, builtAt: Number(p.builtAt) || Date.now(), samples: Number(p.samples) || 0, model: String(p.model ?? ''), basis: Array.isArray(p.basis) ? p.basis.map(String) : null, edited: !!p.edited }
    : null;
  const profile = toProfile(r.profile);
  const history = Array.isArray(r.history) ? r.history.map(toProfile).filter((p): p is VoiceProfile => !!p).slice(0, HISTORY_MAX) : [];
  const amendments: Amendment[] = Array.isArray(r.amendments)
    ? r.amendments.filter((a) => a && typeof a.text === 'string' && a.text.trim()).map((a) => ({ id: String(a.id || uid()), text: a.text.trim().slice(0, AMENDMENT_MAX), at: Number(a.at) || Date.now() })).slice(0, MAX_AMENDMENTS)
    : [];
  const op: Op = OPS.some((o) => o.id === r.op) ? (r.op as Op) : 'rewrite';
  const registerId = typeof r.registerId === 'string' && (r.registerId === '' || registers.some((x) => x.id === r.registerId)) ? r.registerId : (registers[0]?.id ?? '');
  const output: Output | null = r.output && typeof r.output.text === 'string' && r.output.text
    ? { text: r.output.text, op: OPS.some((o) => o.id === r.output!.op) ? r.output.op : 'rewrite', register: String(r.output.register ?? ''), version: r.output.version == null ? null : Number(r.output.version) || null, model: String(r.output.model ?? ''), at: Number(r.output.at) || Date.now() }
    : null;
  return { version: 1, samples, profile, history, amendments, registers, registerId, op, input: typeof r.input === 'string' ? r.input : '', instruction: typeof r.instruction === 'string' ? r.instruction : '', output };
}

export const countWords = (s: string): number => (s.match(/\S+/g) ?? []).length;

/** Cut at a word boundary near the budget. */
function cut(text: string, budget: number): string {
  if (text.length <= budget) return text;
  let end = text.lastIndexOf(' ', budget);
  if (end < budget * 0.8) end = budget;
  return text.slice(0, end).trimEnd();
}

/** How many samples, in order, fit one distill call at this budget. */
export function samplesThatFit(samples: Sample[], budget: number): number {
  let left = budget; let used = 0;
  for (const s of samples) {
    if (left < 200) break;
    left -= Math.min(s.text.length, left); used++;
  }
  return used;
}

/**
 * How many changes to the samples in use since this profile was distilled: added, edited, removed, or switched
 * on or off. Null when the profile predates keeping track, so the widget says nothing rather than guess.
 */
export function samplesChangedSince(p: VoiceProfile | null, samples: Sample[]): number | null {
  if (!p?.basis) return null;
  const basis = new Set(p.basis);
  const inUse = samples.filter((s) => s.use);
  const now = new Set(inUse.map((s) => s.id));
  let n = 0;
  for (const s of inUse) if (!basis.has(s.id) || s.editedAt > p.builtAt) n++;
  for (const id of basis) if (!now.has(id)) n++;
  return n;
}

/** The corrections as the model reads them: a list, cut to a budget on the small local window. */
function amendmentBlock(amendments: string[], budget?: number): string {
  const lines: string[] = []; let left = budget ?? Infinity;
  for (const a of amendments.map((x) => x.trim()).filter(Boolean)) {
    if (a.length + 3 > left) break;
    lines.push(`- ${a}`); left -= a.length + 3;
  }
  return lines.join('\n');
}

// ---------- distilling a voice ----------

export const DISTILL_SYSTEM = 'You are a voice analyst. You distill a precise, reusable voice profile from an author\'s writing samples, so that another model can write as this person: not generically well, recognizably as them. You are describing a real human\'s idiolect. Be specific and evidence-based, quoting short fragments from the samples as proof. No vague praise ("clear and engaging" describes nothing). Capture what is distinctive, flaws and habits included.';

const DISTILL_HEADINGS = `### Diction & vocabulary
Characteristic word choices, register of formality, recurring favorite words and phrases, jargon level, contractions, profanity, how they refer to themselves and the reader.

### Sentence rhythm
Typical sentence length and its variance (the variance is the human tell). Long-then-short? Fragments? Sentences that start with conjunctions? Dashes, parentheticals, semicolons? Describe the cadence so it can be reproduced.

### Structural habits
How they open and close. Lede buried or front-loaded? Lists or prose? Paragraph length. Headers. How they move between ideas.

### Tics & fingerprints
The small repeated moves that give them away: pet phrases, punctuation quirks, capitalization habits, how they hedge or emphasize, signature transitions. For each, say HOW OFTEN it appears ("an emoji maybe once per post", "one exclamation point every few paragraphs"), so a rewrite matches the real rate instead of over-applying it.

### Baseline intensity
The author's default energy, in one or two sentences: measured and matter-of-fact, or breathless and hyped? The resting tone before any tic is added. A rewrite should hit this baseline, not an exaggeration of it.

### What this author would never do
The anti-patterns: phrases, structures, or tones that would read as "not them", especially the generic-AI tells they avoid (reflexive bullet lists, "it's worth noting", "in today's fast-paced world", uniform cadence, hedge-stacking, a summary paragraph that restates everything).`;

/**
 * The distill call: the samples that fit the budget, in the order they were added, and the six headings the
 * profile is written under. Returns how many samples went in, so the widget can say so.
 */
export function distillMessages(author: string, samples: Sample[], budget: number, words: number, amendments: string[] = []): { messages: Message[]; used: number } {
  const picked: string[] = [];
  let left = budget;
  for (const s of samples) {
    if (left < 200) break;
    const text = cut(s.text, left);
    picked.push(`[Sample ${picked.length + 1}${s.source ? ` · ${s.source}` : ''}]\n${text}`);
    left -= text.length;
  }
  const fixes = amendmentBlock(amendments, budget === SAMPLE_BUDGET.local ? LOCAL_AMENDMENT_CHARS : undefined);
  const corrections = fixes ? `## Corrections the author has made to earlier profiles\nThe profile must not contradict these.\n${fixes}\n\n` : '';
  const user = `## Author\n${author.trim() || 'You'}\n\n## Writing samples\n${picked.join('\n\n---\n\n')}\n\n---\n\n${corrections}Produce the voice profile under exactly these headings. Be concrete, and keep the whole profile under ${words} words.\n\n${DISTILL_HEADINGS}\n\nOutput only the profile under these six headings. No preamble.`;
  return { messages: [{ role: 'system', content: DISTILL_SYSTEM }, { role: 'user', content: user }], used: picked.length };
}

// ---------- writing in it ----------

export const VOICE_SYSTEM = 'You rewrite or draft text so it sounds like a specific author: not "better", but like them. The goal is authentic voice. You are not a humanizer and you never optimize against detectors; authentic voice and human rhythm are the whole job, and they read as human because they are the author\'s real voice. Output only the resulting text: the rewrite, or the new draft. No preamble, no explanation, no quotation marks, no notes about what changed. For a draft or a reply, output just the message itself: no "Subject:" line unless asked, and a greeting or sign-off only if this author would use one in this register.';

const CRAFT = `## Craft levers (apply, don't announce)
- A faithful PORTRAIT, not a caricature. Write as the author on an ordinary day, at their natural intensity; don't amplify it. This is the most important lever.
- Use their tics at the author's real frequency, not more: emoji, exclamation points, "actually", "I mean", asides, only as often as the profile says. A couple across a whole piece, not one per sentence.
- Don't open with "Hey everyone!" or breathless hype unless the author actually does.
- Match the length and density to the task. Don't pad, inflate, or ramble to sound casual.
- Vary sentence length and rhythm. Uniform cadence is the dead giveaway; break it.
- Cut hedge-words and scaffolding ("it's worth noting", "essentially", "in order to").
- No reflexive bullet lists unless the author uses them in this register.
- Keep concrete, specific detail, but only detail that fits. Never drag in stray phrases or jargon from the profile because they are distinctive.
- Match the author's diction and tics from the profile, including their flaws.
- No summary or restatement paragraph unless the author does that.`;

/** Turn a register's fields into the instruction block the model reads. No register means the plain voice. */
export function registerGuidance(r: Register | null | undefined): string {
  if (!r) return 'Use the author\'s default voice; no special register constraints.';
  const parts: string[] = [];
  if (r.formality.trim()) parts.push(`Formality: ${r.formality.trim()}.`);
  if (r.length.trim()) parts.push(`Length: ${r.length.trim()}.`);
  if (r.notes.trim()) parts.push(`Rules, follow these EXACTLY, including punctuation and formatting: ${r.notes.trim()}.`);
  return parts.length ? parts.join(' ') : 'Use the author\'s default voice for this register.';
}

export interface TransformInput {
  profile: string | null;
  register: Register | null;
  op: Op;
  text: string;
  instruction: string;
  /** The author's corrections; they override the profile where the two disagree. */
  amendments?: string[];
  /** Cap on the profile as sent, for the small local window. */
  profileChars?: number;
}

export function transformMessages(o: TransformInput): Message[] {
  const profile = o.profile?.trim()
    ? (o.profileChars && o.profile.length > o.profileChars ? cut(o.profile.trim(), o.profileChars) : o.profile.trim())
    : '(no voice profile yet: write in a neutral, plainly human voice)';
  const fixes = amendmentBlock(o.amendments ?? [], o.profileChars ? LOCAL_AMENDMENT_CHARS : undefined);
  const parts = [
    `## The author's voice profile\n${profile}`,
    fixes ? `## The author's own corrections (these override the profile where the two disagree)\n${fixes}` : '',
    `## Register: ${o.register?.name.trim() || 'default'}\n${registerGuidance(o.register)}`,
    `## Operation: ${o.op}\n${OP_GUIDANCE[o.op]}`,
    o.instruction.trim() ? `## Instruction from the user (the intent: what to do, or what to say)\n${o.instruction.trim()}` : '',
    CRAFT,
    `## Source material\n${o.text.trim() || '(no source material: write from the instruction alone)'}`,
  ].filter(Boolean);
  return [{ role: 'system', content: VOICE_SYSTEM }, { role: 'user', content: parts.join('\n\n') }];
}

// ---------- after the model answers ----------

/** True when the register's rules ask for no em dashes. Models do not obey that reliably, so it is enforced after generation. */
export function wantsNoEmDash(r: Register | null | undefined): boolean {
  const notes = (r?.notes ?? '').toLowerCase();
  return !!notes && /(no|without|avoid|never|remove|don.?t)\b.{0,25}(em[\s-]?dash|—)/.test(notes);
}

/** Em dashes, and spaced en dashes used as pauses, become commas; the punctuation around them is tidied. */
export function stripEmDashes(text: string): string {
  return text
    .replace(/\s*—\s*/g, ', ')
    .replace(/(?<=\s)–(?=\s)/g, ',')
    .replace(/,\s*,+/g, ',')
    .replace(/,\s*([.!?;:])/g, '$1')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}

/** The answer as the widget shows it: trimmed, unwrapped from quotes a small model may add, and the register's rules enforced. */
export function cleanOutput(raw: string, register: Register | null | undefined): string {
  let text = raw.trim();
  const wrapped = text.match(/^["“]([\s\S]*)["”]$/);
  if (wrapped && !/["“”]/.test(wrapped[1]!)) text = wrapped[1]!.trim();
  if (wantsNoEmDash(register)) text = stripEmDashes(text);
  return text;
}

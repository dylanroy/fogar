export interface ModelSpec {
  id: string;
  label: string;
  tier: 'smoke' | 'smallest' | 'fast' | 'balanced' | 'best';
  repo: string;
  file: string;
  approxMB: number;
  /** Rough resident memory while loaded, for the recommendation and the picker note. */
  needsGB: number;
  note: string;
}

// File names verified against Hugging Face on 2026-09-21. wllama needs exact paths.
export const MODELS: ModelSpec[] = [
  {
    id: 'smoke', tier: 'smoke',
    label: 'Smoke test (stories260K)',
    repo: 'ggml-org/models', file: 'tinyllamas/stories260K.gguf',
    approxMB: 1, needsGB: 0,
    note: 'One megabyte. Produces nonsense stories. Only proves the pipeline works.',
  },
  {
    id: 'qwen3-0.6b', tier: 'smallest',
    label: 'Smallest: Qwen3 0.6B',
    repo: 'unsloth/Qwen3-0.6B-GGUF', file: 'Qwen3-0.6B-Q4_K_M.gguf',
    approxMB: 400, needsGB: 2,
    note: 'For machines with little memory. Fine for rewrites, weak on everything else.',
  },
  {
    id: 'qwen3.5-0.8b', tier: 'fast',
    label: 'Fast: Qwen3.5 0.8B',
    repo: 'unsloth/Qwen3.5-0.8B-GGUF', file: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    approxMB: 533, needsGB: 3,
    note: 'Quick rewrites and summaries. Loads in about a second once cached.',
  },
  {
    id: 'qwen3.5-2b', tier: 'balanced',
    label: 'Balanced: Qwen3.5 2B',
    repo: 'unsloth/Qwen3.5-2B-GGUF', file: 'Qwen3.5-2B-Q4_K_M.gguf',
    approxMB: 1281, needsGB: 5,
    note: 'Noticeably smarter. The right choice on a recent laptop with WebGPU.',
  },
  {
    id: 'qwen3.5-4b', tier: 'best',
    label: 'Best: Qwen3.5 4B',
    repo: 'unsloth/Qwen3.5-4B-GGUF', file: 'Qwen3.5-4B-Q4_K_M.gguf',
    approxMB: 2741, needsGB: 8,
    note: '2.7 GB download. Needs WebGPU and 16 GB of memory to feel good.',
  },
];

export const DEFAULT_MODEL_ID = 'qwen3.5-0.8b';
export const modelById = (id: string): ModelSpec => MODELS.find((m) => m.id === id) ?? MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!;

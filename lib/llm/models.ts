export interface ModelSpec {
  id: string;
  label: string;
  repo: string;
  file: string;
  approxMB: number;
  /** Qwen3 models think by default; this system prompt suffix turns it off for snappy answers. */
  noThinkSuffix?: string;
  note: string;
}

// File names should be re-verified against Hugging Face before launch; wllama needs exact paths.
export const MODELS: ModelSpec[] = [
  {
    id: 'smoke',
    label: 'Smoke test (stories260K)',
    repo: 'ggml-org/models',
    file: 'tinyllamas/stories260K.gguf',
    approxMB: 1,
    note: 'One megabyte. Produces nonsense stories. Only proves the pipeline works.',
  },
  {
    id: 'qwen3-0.6b',
    label: 'Fast: Qwen3 0.6B (Q4)',
    repo: 'unsloth/Qwen3-0.6B-GGUF',
    file: 'Qwen3-0.6B-Q4_K_M.gguf',
    approxMB: 400,
    noThinkSuffix: ' /no_think',
    note: 'Quick facts and rewrites. Loads in seconds once cached.',
  },
  {
    id: 'qwen3-1.7b',
    label: 'Balanced: Qwen3 1.7B (Q4)',
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    approxMB: 1100,
    noThinkSuffix: ' /no_think',
    note: 'Most questions. Needs WebGPU to feel fast.',
  },
];

export const modelById = (id: string): ModelSpec => MODELS.find((m) => m.id === id) ?? MODELS[1]!;

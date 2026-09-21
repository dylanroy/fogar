import { MODELS, type ModelSpec } from './llm/models';

export interface DeviceProfile {
  webgpu: boolean;
  /** Chrome reports device memory in GB, rounded and capped at 8. */
  memoryGB: number | null;
  cores: number;
  gpuArchitecture: string | null;
  gpuVendor: string | null;
}

export async function detectDevice(): Promise<DeviceProfile> {
  const nav = navigator as any;
  let webgpu = false; let gpuArchitecture: string | null = null; let gpuVendor: string | null = null;
  try {
    const adapter = nav.gpu ? await nav.gpu.requestAdapter() : null;
    webgpu = !!adapter;
    gpuArchitecture = adapter?.info?.architecture || null;
    gpuVendor = adapter?.info?.vendor || null;
  } catch { webgpu = false; }
  return { webgpu, memoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null, cores: navigator.hardwareConcurrency || 4, gpuArchitecture, gpuVendor };
}

/**
 * Pick the largest tier that will feel good on this machine. Chrome caps reported memory at 8 GB, so "8" means
 * "8 or more". The 4B model (2.7 GB) measured 44 tok/s on Apple silicon and is the first tier that gets facts,
 * arithmetic, and classification right, so it is recommended on Apple, NVIDIA, and AMD GPUs with 8 GB+.
 * Integrated Intel and unknown GPUs get the 2B; machines without WebGPU get the 0.8B on the CPU.
 */
export function recommendModel(d: DeviceProfile): ModelSpec {
  const mem = d.memoryGB ?? 4;
  const pick = (id: string) => MODELS.find((m) => m.id === id)!;
  const vendor = `${d.gpuVendor ?? ''} ${d.gpuArchitecture ?? ''}`.toLowerCase();
  const strongGpu = /apple|metal|nvidia|amd|radeon/.test(vendor);
  if (d.webgpu && mem >= 8 && strongGpu) return pick('qwen3.5-4b');
  if (d.webgpu && mem >= 8) return pick('qwen3.5-2b');
  if (mem <= 2) return pick('qwen3-0.6b');
  return pick('qwen3.5-0.8b');
}

export function describeDevice(d: DeviceProfile): string {
  const parts = [d.webgpu ? `WebGPU${d.gpuArchitecture ? ` (${d.gpuArchitecture})` : ''}` : 'no WebGPU, CPU only'];
  if (d.memoryGB) parts.push(`${d.memoryGB}${d.memoryGB >= 8 ? '+' : ''} GB memory`);
  parts.push(`${d.cores} cores`);
  return parts.join(' · ');
}

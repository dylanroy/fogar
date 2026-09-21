import type { Plugin } from 'vite';

/**
 * wllama creates its inference worker (and its OPFS helper worker) from a Blob URL.
 * Manifest V3 extension pages refuse blob: workers: the CSP floor is
 * `script-src 'self' 'wasm-unsafe-eval'` and cannot be relaxed.
 *
 * @wllama/wllama's package "main" points at TypeScript source, so Vite bundles
 * node_modules/@wllama/wllama/src/utils.ts directly. This plugin rewrites `createWorker`
 * there so it spawns the static files that scripts/gen-wllama-workers.mjs writes into
 * public/wllama/. Runtime options wllama used to inline into the worker source travel in
 * the worker URL's query string.
 *
 * Pinned to @wllama/wllama 3.6.1. If the createWorker source changes, the build fails
 * loudly instead of silently shipping a blob worker that Chrome will block.
 */
const ORIGINAL = "export const createWorker = (workerCode: string | Blob): Worker => {\n  const workerURL = URL.createObjectURL(\n    isString(workerCode)\n      ? new Blob([workerCode], { type: 'text/javascript' })\n      : (workerCode as Blob)\n  );\n  return new Worker(workerURL, { type: 'module' });\n};";

const REPLACEMENT = "export const createWorker = (workerCode: string | Blob): Worker => {\n  // Fogar: Manifest V3 forbids blob: workers. Spawn the static files from scripts/gen-wllama-workers.mjs instead.\n  if (!isString(workerCode)) throw new Error('[fogar] wllama passed a Blob worker; MV3 needs a static file');\n  const code = workerCode as string;\n  const rt = (globalThis as any).chrome?.runtime;\n  const base: string = rt?.getURL ? rt.getURL('/wllama/') : '/wllama/';\n  if (code.includes('wModuleInit')) {\n    const m = code.match(/^const RUN_OPTIONS = (\\{.*?\\});/);\n    const opts: Record<string, unknown> = m ? JSON.parse(m[1]) : {};\n    opts.moduleUrl = base + 'module.js';\n    opts.noWebGPU = code.includes('WorkerNavigator.prototype,\"gpu\"');\n    return new Worker(base + 'llama-worker.js?o=' + encodeURIComponent(JSON.stringify(opts)), { type: 'module' });\n  }\n  if (code.includes('accessHandle')) {\n    return new Worker(base + 'opfs-worker.js', { type: 'module' });\n  }\n  throw new Error('[fogar] unknown wllama worker code; update lib/vite-plugin-wllama-mv3.ts');\n};";

export function wllamaMv3(): Plugin {
  return {
    name: 'fogar:wllama-mv3',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/@wllama/wllama/src/utils.ts')) return null;
      if (!code.includes(ORIGINAL)) {
        throw new Error(`[fogar] @wllama/wllama createWorker source changed; update ORIGINAL in lib/vite-plugin-wllama-mv3.ts (${id})`);
      }
      return { code: code.replace(ORIGINAL, REPLACEMENT), map: null };
    },
  };
}

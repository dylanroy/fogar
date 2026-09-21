import { defineConfig } from 'wxt';
import { wllamaMv3 } from './lib/vite-plugin-wllama-mv3';

// Fogar manifest. Everything here is deliberate; see README "Manifest V3 constraints".
export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  manifest: ({ command }) => ({
    name: 'Fogar',
    short_name: 'Fogar',
    description:
      'A private new tab. Ask anything; answers come from a model running in your browser, or from a cloud endpoint you bring your own key for.',
    permissions: ['storage', 'contextMenus'],
    // Cloud endpoints are user-chosen; their origin is requested at save time, never up front.
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    // Model weights are data, not code. They are fetched from Hugging Face and cached in OPFS.
    host_permissions: ['https://huggingface.co/*', 'https://*.huggingface.co/*', 'https://*.hf.co/*'],
    content_security_policy: {
      // 'wasm-unsafe-eval' is the only relaxation MV3 allows for script-src. No blob:, no remote code.
      // localhost is permitted only for unpacked extensions, which is what `wxt` dev mode loads.
      extension_pages:
        command === 'serve'
          ? "script-src 'self' 'wasm-unsafe-eval' http://localhost:3000; object-src 'self';"
          : "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    // Cross-origin isolation gives extension pages SharedArrayBuffer, which wllama's multi-thread build needs.
    cross_origin_embedder_policy: { value: 'require-corp' },
    cross_origin_opener_policy: { value: 'same-origin' },
  }),
  vite: () => ({
    plugins: [wllamaMv3()],
  }),
});

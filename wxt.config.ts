import { defineConfig } from 'wxt';
import { wllamaMv3 } from './lib/vite-plugin-wllama-mv3';

// WXT_E2E=1 builds a test variant into .output-e2e with a host permission for the local mock server, so the
// end-to-end suite can exercise the real right-click path (scripting.executeScript on a web page).
const E2E = process.env.WXT_E2E === '1';

// Fogar manifest. Everything here is deliberate; see README "Manifest V3 constraints".
export default defineConfig({
  srcDir: '.',
  outDir: E2E ? '.output-e2e' : '.output',
  manifest: ({ command }) => ({
    name: 'Fogar',
    short_name: 'Fogar',
    description:
      'A private new tab. Ask anything; answers come from a model running in your browser, or from a cloud endpoint you bring your own key for.',
    // activeTab + scripting: on a right-click "Ask Fogar about …", read the title, address, and text around the
    // selection from that one page, that one time. No install warning; nothing runs on pages otherwise.
    // unlimitedStorage carries no install warning; saved sessions can outgrow the default quota.
    // The e2e build takes `tabs` up front because Playwright cannot click Chrome's permission prompt.
    permissions: ['storage', 'contextMenus', 'alarms', 'notifications', 'bookmarks', 'favicon', 'activeTab', 'scripting', 'unlimitedStorage', ...(E2E ? ['tabs'] : [])],
    // `tabs` is asked for only when the Sessions widget is added; Chrome labels it "Read your browsing history".
    optional_permissions: ['tabs'],
    // Cloud endpoints are user-chosen; their origin is requested at save time, never up front.
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    // Model weights are data, not code. They are fetched from Hugging Face and cached in OPFS.
    host_permissions: ['https://huggingface.co/*', 'https://*.huggingface.co/*', 'https://*.hf.co/*', ...(E2E ? ['http://127.0.0.1/*'] : [])],
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

# Fogar

A private new tab. Ask anything; the answer comes from a model running inside your browser, or from a cloud endpoint you bring your own key for. No account, no server, nothing leaves the machine in local mode.

*Fogar* is Galician for hearth: the fire at the center of the home, on your own machine.

Live at [fogar.ai](https://fogar.ai). Built by [Dylan Roy](https://dylanroy.com).

## Status

Release candidate v0.1.0. Everything below works end to end and is covered by `npm run test:spike`, which loads the built extension into Chromium and drives 23 flows against local mock servers.

- Ask bar with streaming, Markdown-rendered answers and follow-ups, from a local model (wllama, WebGPU or CPU) or any OpenAI-compatible endpoint with your own key.
- Model tiers: Qwen3.5 0.8B (533 MB), 2B (1.3 GB), 4B (2.7 GB). First run recommends a tier from the GPU vendor and device memory. Thinking mode is off. WebGPU failures fall back to the CPU.
- One box, several outcomes: URLs open, `?` searches, "remind me…" sets a reminder, "todo: …" adds a todo, arithmetic is computed locally, bookmark questions go to a finder that has the model sort your bookmarks, everything else goes to the model. Cmd/Ctrl+Enter always searches.
- Opt-in web grounding with a Brave Search or Tavily key: five snippets, citations, sources.
- Recipes: data-only prompt forms. Four built-ins. Create, edit, import, export, share as a link, pin to the page.
- Widgets, as data: Agenda (any iCal feed, recurring events included), Todos, Reminders (plain-language parser, confirm, `chrome.alarms`, notifications, Google Calendar link), Links, Notes, Weather (Open-Meteo, no key), Recipe. Reorder, configure, remove, add. Focus mode.
- Right-click "Ask Fogar about …". Bookmark search as you type.
- A network ledger that counts every request this tab made, by host. Backup and restore of everything.
- Landing page and privacy policy in `site/`. Store listing copy and generated assets in `store/`.

Not yet: store submission, public repo, domains. See [ROADMAP.md](ROADMAP.md).

## Measured

`scripts/eval-models.mjs` runs a fixed prompt set per model in Chromium with WebGPU on an M-series Mac. Warm load is from the OPFS cache.

| Model | Download | Warm load | Speed | Rewrite | Fact | 18% of 240 | Sort 6 bookmarks | Extract date |
|---|---|---|---|---|---|---|---|---|
| Qwen3.5 0.8B Q4 | 533 MB | 1.3 s | 92 tok/s | replied instead of rewriting | right | wrong | 1 of 3 wrong | wrong |
| Qwen3.5 2B Q4 | 1.3 GB | 1.8 s | 71 tok/s | replied instead of rewriting | right | wrong | missed 1 | label right, date wrong |
| Qwen3.5 4B Q4 | 2.7 GB | 3.2 s | 44 tok/s | right | right | right | right | right |

The 4B is the first tier that behaves like an assistant, which is why it is recommended wherever the GPU can carry it. The rewrite template now carries a one-shot example so the smaller tiers rewrite instead of reply, and arithmetic never reaches the model.

## Stack

- [WXT](https://wxt.dev) 0.21 for the extension build (Vite 8, MV3 manifest generation, Chrome and Firefox targets).
- [@wllama/wllama](https://github.com/ngxson/wllama) 3.6.1, pinned. llama.cpp compiled to WebAssembly with WebGPU offload.
- Vanilla TypeScript for the spike. A small framework (Preact or Svelte) comes in Phase 2 if the UI grows.
- Playwright for the smoke test that loads the built extension into Chromium.

## Commands

```bash
npm install          # also runs `wxt prepare`
npm run dev          # generate worker files, then WXT dev server with an unpacked extension
npm run build        # production build to .output/chrome-mv3
npm run test:spike   # build first; end-to-end test of all nine flows in Chromium
npm run shots        # light and dark screenshots to .output/shots
npm run zip          # store-ready zip in .output/
node scripts/eval-models.mjs      # model quality and speed, see Measured
node scripts/store-assets.mjs     # store screenshots and promo tiles into store/
```

Load the unpacked extension from `.output/chrome-mv3` at `chrome://extensions` with Developer mode on. Open a new tab.

After rebuilding, click Reload on the extension card (or bump the version). Chrome keeps the background service worker of an installed extension until the version changes or it is reloaded, so a rebuilt background script is otherwise ignored while pages load fresh. The same applies to persistent Playwright profiles: the eval profile runs an old background script; the e2e suite uses a fresh profile every run.

Smoke test variants: `HEADED=1` to watch it, `GPU=1` for the WebGPU path, `MODEL=qwen3-0.6b` to use the real 400 MB model, `VERBOSE=1` for every console line. The test also covers a warm OPFS reload and cloud mode against a local mock OpenAI server.

`npm run gen:icons` re-renders `public/icon/*.png` from the SVG mark in `scripts/gen-icons.mjs`.

`npm run site` wraps `site/page.html` into the deployable `site/index.html` for fogar.ai. The page body is kept separate so the same file can be previewed as a Claude artifact.

## Manifest V3 constraints, and how each is handled

| Constraint | Consequence | Where it is handled |
|---|---|---|
| Extension pages cannot run remote code | wllama's wasm and worker scripts must ship inside the extension | `scripts/gen-wllama-workers.mjs` copies `wllama.wasm` and writes the worker files into `public/wllama/` |
| CSP floor is `script-src 'self' 'wasm-unsafe-eval'`, no `blob:` | wllama's Blob-URL workers are refused | `lib/vite-plugin-wllama-mv3.ts` rewrites `createWorker` in wllama's source to spawn the static files; runtime options travel in the worker URL query string |
| emscripten spawns pthread workers from `mainScriptUrlOrBlob` | wllama passes a Blob, which would also be refused | the generator replaces that argument with the URL of the static `module.js` |
| SharedArrayBuffer needs cross-origin isolation | multi-thread wasm build would be unavailable | `cross_origin_embedder_policy` and `cross_origin_opener_policy` manifest keys in `wxt.config.ts` |
| Model weights are data, not code | fetching GGUF from Hugging Face is allowed | `host_permissions` for huggingface.co; weights cached in OPFS by wllama |
| Cloud endpoints are user-chosen | cannot list every origin up front | `optional_host_permissions`, requested when the user saves an endpoint |
| Only `chrome_url_overrides` may replace the new tab | anything else is a store violation | WXT's `entrypoints/newtab/` entry generates exactly that key |

The plugin and generator are pinned to the exact source text of wllama 3.6.1. Upgrading wllama makes the build fail with a message telling you what to update, rather than silently shipping a blob worker Chrome will block.

## Spike checklist

Results from 2026-09-21 on an M-series Mac, Playwright Chromium 153 (new headless), `npm run test:spike`:

- [x] Build produces an MV3 extension with no `blob:` worker in the newtab bundle
- [x] 1 MB test model downloads, loads, and streams tokens under the MV3 CSP
- [x] Warm reload of the same model makes zero GGUF downloads (weights served from OPFS). Two small Hugging Face repo-listing calls still happen on load even with `allowOffline`; making local mode fully network-silent after caching is a Phase 2 item
- [x] WebGPU path works: adapter reported `vendor: apple, architecture: metal-3`, all layers offloaded (`GPU=1`)
- [x] Multi-thread CPU path works: `Multithread enabled: true, pthreadPoolSize: 8`, so the COOP/COEP manifest keys do their job
- [x] Qwen3 0.6B Q4 answers a real question. Headless Chromium, CPU, 8 threads: 397 MB cold download and load in about 40 s, warm reload in 1.3 s, first token 355 ms, 104 tokens/s. Also confirmed manually in Chrome with WebGPU
- [x] Cloud mode streams from an OpenAI-compatible endpoint. The smoke test runs a local mock server and checks the SSE parser, the bearer header, and `stream: true`. The optional permission prompt is exercised manually
- [ ] Firefox: single-thread only (extension pages get no SharedArrayBuffer there); decide whether to ship

Exit criterion for Phase 1 was a warm start of Qwen3 0.6B to first token in under two seconds. Measured: about 1.7 s on CPU. **Phase 1 is done.**

Known fix from the first manual run: clicking "Download and load" twice mid-download produced `removeEntry ... modifications are not allowed`, because the first OPFS writer still held the file. The load button is now disabled while a load is in flight.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for phases, gates, the recipe gallery plan, and everything decided against.

## Privacy stance

Local mode makes no network requests after the model is cached. Cloud mode sends prompts only to the endpoint the user typed in. No analytics in the extension. This is also the cheapest possible Chrome Web Store data disclosure.

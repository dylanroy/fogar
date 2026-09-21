# Fogar

A private new tab. Ask anything; the answer comes from a model running inside your browser, or from a cloud endpoint you bring your own key for. No account, no server, nothing leaves the machine in local mode.

*Fogar* is Galician for hearth: the fire at the center of the home, on your own machine.

Live at [fogar.ai](https://fogar.ai). Built by [Dylan Roy](https://dylanroy.com).

## Status

Phase 1 spike. The goal of this phase is a single yes/no: **can wllama run inside a Manifest V3 extension page with weights cached in OPFS?** See "Spike checklist" below.

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
npm run test:spike   # build first; loads the extension into Chromium and streams from a 1 MB model
```

Load the unpacked extension from `.output/chrome-mv3` at `chrome://extensions` with Developer mode on. Open a new tab.

Smoke test variants: `HEADED=1` to watch it, `GPU=1` for the WebGPU path, `MODEL=qwen3-0.6b` to use the real 400 MB model, `VERBOSE=1` for every console line. The test also covers a warm OPFS reload and cloud mode against a local mock OpenAI server.

`npm run gen:icons` re-renders `public/icon/*.png` from the SVG mark in `scripts/gen-icons.mjs`.

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

1. **Spike** (this phase). Prove the pipeline. Draft blog post one while the gotchas are fresh.
2. **Product.** Done so far: cached model auto-loads on every new tab, stop button, plain web search before a model is ready, right-click "Ask Fogar about …", model cache size and clear, icons. Still to do: first-run chooser, a real design pass, WebGPU numbers in real Chrome.
2b. **Web grounding, opt-in.** A 0.6B model is a summarizer, not an encyclopedia; asked who the US president is it says Obama. Add an optional search step (bring-your-own Brave Search or Tavily key, both have free tiers) that fetches a handful of snippets and has the local model answer from them with citations. Off by default so the "nothing leaves this browser" promise holds unless the user turns it on.
3. **Your corner.** Bookmarks search from the ask bar (`bookmarks` permission, local only). Todos and reminders in extension storage with `chrome.alarms` and notifications. Natural-language create/remove via wllama tool calling, with confirmation before anything is deleted.
4. **Promo surface and sponsor slot.** Footer rotates own products with `ref=fogar`. "Sponsor this slot" page on fogar.ai. Sell nothing until a few thousand weekly actives; label anything sponsored.
5. **Store and launch.** Single-purpose statement, privacy policy that says "we store nothing", Show HN.
6. **Write-ups on dylanroy.com.** The build, the launch numbers, the sponsor experiment.

## Decided against, for now

- **User-authored widgets.** Manifest V3 bars arbitrary code in extension pages, so user JavaScript could only run in a sandboxed iframe with message passing. That is a platform, not a feature, and the store treats "runs user code" with suspicion. A fixed set of toggleable built-in panels (todos, bookmarks, reminders, clock) covers most of the value.
- **Analytics inside the extension.** Cuts against the privacy pitch and complicates the store listing.

## Privacy stance

Local mode makes no network requests after the model is cached. Cloud mode sends prompts only to the endpoint the user typed in. No analytics in the extension. This is also the cheapest possible Chrome Web Store data disclosure.

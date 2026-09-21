# Blog post 1 draft: I put a language model inside a Chrome new tab page

Target: dylanroy.com. Audience: developers who have heard "LLMs in the browser" and want to know what actually breaks. Voice: first person, one build, real numbers. Working title options at the bottom.

## Hook

Every new tab I open is a blank page asking me what I want. Fogar makes it answer back, from a model running on my own machine, with no account, no API key, and no server. This is what it took to make that work inside a Manifest V3 extension, in one weekend.

## What I built and why

- New tab override with an ask bar. Toggle between a model in the browser (wllama, llama.cpp compiled to WebAssembly) and any OpenAI-compatible endpoint with your own key.
- Motivation: a privacy-first assistant that is also a small promo surface for my other projects, and a build worth writing about. Be honest that the second reason is real.
- The bet: wllama 3 shipped WebGPU offload and OPFS caching, so the hard inference work is done. The open question was whether Chrome's extension sandbox would let it run at all.

## The four things that broke

### 1. The package entry point is TypeScript source

`@wllama/wllama` sets `"main": "index.ts"`. Vite happily bundles it, which is convenient right up to the moment you try to patch the built bundle and nothing changes. Any transform has to target `src/utils.ts`, not `esm/index.js`. Lost an hour here. Include the debug log line that revealed it.

### 2. Manifest V3 refuses blob: workers, and wllama only makes blob: workers

- MV3 CSP floor for extension pages is `script-src 'self' 'wasm-unsafe-eval'`. You cannot add `blob:`, `data:`, or `unsafe-eval`. Not "discouraged". Rejected at install.
- wllama builds its worker source as a string at runtime (config JSON + emscripten glue + worker loop) and calls `new Worker(URL.createObjectURL(new Blob([code])))`.
- Fix: a Vite plugin that rewrites `createWorker` to spawn static files the build generates from wllama's own exported code strings. The runtime config that used to be inlined rides in the worker URL's query string, read back with `self.location.search`.
- Show the before and after of `createWorker`. Show the one-line `RUN_OPTIONS` change.
- Pinned to an exact version with an exact-text match. If wllama changes the function, the build fails and tells you what to update. Prefer that to a silent regression.

### 3. Threads spawn threads, also from blobs

- With SharedArrayBuffer available, emscripten spawns pthread workers from `mainScriptUrlOrBlob`. wllama passes a Blob. Same CSP wall.
- Fix: the generator swaps that argument for the URL of a static `module.js`. Emscripten accepts a string there and skips `createObjectURL`.
- SharedArrayBuffer itself needs cross-origin isolation, which for extensions is two manifest keys: `cross_origin_embedder_policy` and `cross_origin_opener_policy`. Result: `Multithread enabled: true, pthreadPoolSize: 8`.

### 4. The bug I found by clicking twice

- Second click on "Download and load" while the first download was running. wllama's OPFS writer runs in its own worker holding a sync access handle. Tearing down the instance did not release it before the retry tried `removeEntry` on the partial file. `NoModificationAllowedError`.
- Fix is boring: one load at a time, button disabled while in flight. Lesson: the first manual test finds the thing the automated test cannot, because the automated test never double clicks.

### 5. The model I should have started with

- Started on Qwen3 0.6B because it was small. It said Obama was president and that 18% of 240 is 432.
- Wrote a 40-line eval harness: load the extension in Playwright, run six prompts per model, record first token, tokens per second, and the text. Ran Qwen3.5 0.8B, 2B, and 4B in an hour.
- Table from the README. The 4B is the first one that rewrites instead of replying, does the percentage, sorts the bookmarks, and extracts a date. 44 tokens a second on WebGPU. The 2.7 GB single file loaded without splitting.
- Lesson: pick the model from measurements on the actual runtime, not from the download size. And compute arithmetic yourself; no small model should be asked what 18% of 240 is.

## What did not break

- Fetching 400 MB of weights from Hugging Face from an extension page. Weights are data, not code. `host_permissions` for huggingface.co and it just works, including under COEP `require-corp`, because Hugging Face sends CORS headers.
- OPFS caching on a `chrome-extension://` origin. Warm reload served the whole model from disk with zero GGUF downloads.
- WebGPU inside an extension page. Adapter reported Apple Metal 3, all layers offloaded. Even in Playwright's headless Chromium.

## Numbers

Qwen3 0.6B, Q4_K_M, 397 MB, M-series Mac, CPU path with 8 threads:

| | |
|---|---|
| Cold download and load | ~40 s |
| Warm reload from OPFS | 1.3 s |
| First token | 355 ms |
| Generation | 104 tokens/s |

Add WebGPU numbers from a manual run in real Chrome before publishing.

## How to test an extension that downloads 400 MB

- Playwright, `launchPersistentContext` with `--load-extension`, new headless mode supports extensions.
- Find the extension id from the service worker URL.
- A `?smoke=1` query on the new tab page drives the flow; `data-status` on `<body>` is the assertion point.
- Reload once and count Hugging Face responses to prove the cache. Point cloud mode at a 40-line mock OpenAI server to prove the SSE parser.
- The whole thing runs in under three seconds with a 1 MB test model, and about 40 with the real one.

## Widgets without code

- Manifest V3 forbids user code, so "let people build widgets" became "let people configure typed panels with data". Agenda is a pasted iCal URL and a 200-line RFC 5545 subset (recurrence expansion is the fun part). Weather is Open-Meteo, which needs no key. Recipes are prompt forms as JSON, shareable as a link.
- The constraint produced a better product: nothing on the page can phone home unless the user typed the address, and the network ledger in Settings proves it.

## What is next

Store submission, the recipe gallery once people make recipes worth sharing, Google Calendar read-only OAuth after the store review, one shared model instance across tabs. Link to fogar.ai. Link to the repo.

## Title options

- I put a language model inside a Chrome new tab page. Here is what broke.
- Running llama.cpp inside a Manifest V3 extension
- Four things Chrome will not let your extension do, and how wllama trips over three of them
- No key, no account, no server: an LLM in your new tab

## Post 2 and 3 placeholders

- Post 2: launch numbers after a month. Installs, retention, what the footer link actually sent to each product.
- Post 3: the sponsor slot experiment, whatever happened.

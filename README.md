# Fogar

A private new tab. Ask anything; the answer comes from a model running inside your browser, or from a cloud endpoint you bring your own key for. No account, no server, nothing leaves the machine in local mode.

*Fogar* is Galician for hearth: the fire at the center of the home, on your own machine.

Live at [fogar.ai](https://fogar.ai). Built by [Dylan Roy](https://dylanroy.com).

## Status

v0.1.1, on the [Chrome Web Store](https://chromewebstore.google.com/detail/fogar/cepnifpajfejaghhhaheadokfofcmoia). Everything below works end to end and is covered by `npm run test:spike`, which loads the built extension into Chromium and runs 81 checks against local mock servers.

- Ask bar with streaming, Markdown-rendered answers and follow-ups, from a local model (wllama, WebGPU or CPU) or any OpenAI-compatible endpoint with your own key.
- Model tiers: Qwen3.5 0.8B (533 MB), 2B (1.3 GB), 4B (2.7 GB). First run recommends a tier from the GPU vendor and device memory; the 4B only on Apple silicon, where memory is unified. Thinking mode is off. WebGPU failures fall back to the CPU.
- A new tab loads nothing by itself. The cached model comes up when you type a question, open a recipe, or ask, and a tab nobody has looked at for five minutes gives it back. Opening tabs to type a URL stays free.
- One box, several outcomes: URLs open, `?` searches, "remind me…" sets a reminder, "todo: …" adds a todo, arithmetic is computed locally, bookmark questions go to a finder that has the model sort your bookmarks, everything else goes to the model. Cmd/Ctrl+Enter always searches. A "What can I type here?" chip lists all of this as a card.
- The first screen teaches by example: the placeholder is one quoted request, different on each tab; four chips rotate from a pool that covers every route (writing tasks appear once a model can answer, bookmarks and open tabs when available); the attach and send controls sit inside the box, so the row below is only status.
- Attachments: drop a PDF, Word (.docx), HTML, or text file anywhere on the page, press + in the box, or paste one. Read in the page (pdf.js for PDFs, an unzipper for Word), never uploaded or stored. The text rides in the system prompt with the same "say when the file does not contain the answer" line as a right-click page, stays for follow-ups, and leaves with the conversation. The chip says how much fit: "12 pages · read the first 3". On this device the budget is about 1,200 words, so the 4,096-token window still holds the conversation and the answer; recipe fields take a dropped file too.
- Opt-in web grounding. Free by default with no key: DuckDuckGo's Instant Answer API plus Wikipedia, good for well-known people, places, and terms. Add a Brave Search or Tavily key for full web results. Snippets go in front of the question; the answer cites its sources, and only cited results are listed. Wikipedia hits that matched on body text alone are dropped. A question about an attached file is answered from the file and skips the search; Dig deeper adds the web on request, as a supplement to the file.
- Recipes: data-only prompt forms. Four built-ins. Create, edit, import, export, share as a link, pin to the page.
- Writing widget: the Draft & rewrite recipe, but it knows who is writing. Paste a few things you actually sent, or drop files, and distill them once into a voice profile (diction, sentence rhythm, structural habits, tics with their real frequency, baseline intensity, a never-do list) that is plain text you can read and edit. Samples stay editable: open one to fix or trim it, or uncheck it to keep it without distilling from it, and the profile says when it has fallen behind them. One-line corrections ("I never say 'reach out'") ride along on every run and through every distill, and earlier profiles are kept for restoring, hand edits included. Then rewrite, tighten, warm up, or draft in that voice. Registers are modes under the one voice: Email, Chat, and Essay out of the box and any you add, each with a formality, a length, and rules followed exactly; "no em dashes" is also enforced after the model answers, since models do not obey it reliably. Runs on the device model, the Settings endpoint, or any model profile from an LLM Chat widget, with budgets that keep the 4,096-token local window honest and say when a sample did not fit. One widget is one voice, so a second carries a client's or a brand's. The method and prompts come from [Dickens](https://dickens.ai), the same author's voice engine; the widget carries a light version of it and credits it in the card's corner.
- Widgets, as data: Agenda (any iCal feed, recurring events included), Todos (click to edit, drag to reorder), Reminders (plain-language parser, confirm, `chrome.alarms`, notifications, Google Calendar link), Links, Notes, Weather (Open-Meteo, no key), Recipe. Reorder, configure, remove, add. Focus mode.
- Sessions widget: save your open windows and close them without fear. The open-window list doubles as a switcher: each window is named by its active tab and clicking it brings it to the front. Per window or all at once, duplicates collapsed, searchable from the widget and the ask bar (open tabs as well as saved ones, so a hit you can switch to outranks one you would have to restore), restore with tabs loading only when clicked, promote tabs or a whole session into a bookmark folder, export a session or all of them as a Markdown list, a bookmarks file any browser imports, or a Fogar file that restores. Needs the `tabs` permission, asked for only when the widget is added.
- Seven more widgets, each a config form plus a render function, each bring-your-own-key, nothing through a Fogar server. **Inbox**: Gmail's unread feed for the signed-in account (a label is the filter), or the Gmail API through your own OAuth client with any search as the filter. **Feed**: RSS, Atom, JSON Feed, a site address that advertises its feed, and searches on Google News, Hacker News, Reddit, or Bing News, merged newest first with a dot on what is new. **Jira**: any JQL with your API token, read-only. **LLM Chat**: the device model, the Settings endpoint, or profiles for Anthropic (Messages API), OpenAI, OpenRouter, Gemini, Groq, Ollama, LM Studio, or any OpenAI-compatible server; models fetched from the endpoint; conversations persist. **Canvas**: pen, highlighter, arrows, boxes, ellipses, text, eraser, undo and redo; tell the model what to draw and it answers with shapes as data that are validated before they are drawn; PNG export. **Notebook**: ruled pages, and a photo of a page becomes text, on this device with Tesseract (English data ships inside the extension, printed text) or through a vision model you connected (handwriting). **Post-its**: sticky notes you drag, stack, and pull off onto another card, where the note becomes its own widget. Every widget has a full-screen control; Escape brings the page back.
- Right-click "Ask Fogar about …" carries the page along: title, address, and the text around the selection go in front of the model, so a small model answers from the page it was on instead of guessing.
- "Dig deeper" on every answer: search the web and answer again (grounded, cited), think longer (reasoning mode with a 600-token budget, local thinking models), or ask the other model (cloud or local). Each re-ask replaces the earlier exchange in the conversation.
- The system prompt tells the model to say when it does not know rather than invent names, dates, or numbers.
- Bookmark search as you type.
- Customize: appearance (system, light, or dark; six curated accents or any hue; warm, neutral, or cool paper; serif or sans headings; comfortable or compact density) and layout (ask box at the top or centered, widgets in a sidebar on wide windows, two, three, or four widget columns, a normal, wide, or full page width, hide the recipes row). Drag a widget's title to reorder. A theme is a dozen numbers, never CSS: colors derive in OKLCH at fixed lightness, so every choice stays readable in both light and dark, and a theme shares as a link. A tiny boot script paints the saved theme and layout before the first frame.
- A network ledger that counts every request this tab made, by host. Backup and restore of everything.
- Landing page, five use-case pages (tabs, bookmarks, writing, your voice, your day), sitemap, and privacy policy in `site/`. Store listing copy and generated assets in `store/`.
- The same page as an installable web app at [app.fogar.ai](https://app.fogar.ai), for phones and for browsers the extension does not reach. Local or cloud model, recipes, Writing, chat, todos, notes, links, post-its, notebook, canvas, weather, attachments, grounding; it opens and answers with no connection once it has been opened online. The widgets that need extension APIs or cross-origin fetches (Sessions, bookmarks, Inbox, Feed, Jira, Agenda) are not offered there. See "The web app" below.

Next: see [ROADMAP.md](ROADMAP.md).

## Measured

`scripts/eval-models.mjs` runs a fixed prompt set per model in Chromium with WebGPU on an M-series Mac. Warm load is from the OPFS cache.

| Model | Download | Warm load | Speed | Rewrite | Fact | 18% of 240 | Sort 6 bookmarks | Extract date | Read a 900-word letter |
|---|---|---|---|---|---|---|---|---|---|
| Qwen3.5 0.8B Q4 | 533 MB | 1.3 s | 92 tok/s | replied instead of rewriting | right | wrong | 1 of 3 wrong | wrong | right, first token 0.9 s |
| Qwen3.5 2B Q4 | 1.3 GB | 1.8 s | 71 tok/s | replied instead of rewriting | right | wrong | missed 1 | label right, date wrong | right, first token 1.7 s |
| Qwen3.5 4B Q4 | 2.7 GB | 3.2 s | 44 tok/s | right | right | right | right | right | right, first token 4.1 s |

**Reading a document** (the `document` case, 2026-09-23): a 915-word letter goes in the system prompt the way an attached file does, and the question asks for three facts planted near its end (who invoiced, how much, due when). All three tiers answered correctly on WebGPU; finding facts in text that is in front of the model is easier for the small tiers than the date arithmetic of the extract case. The first-token time is the cost of reading: 0.9 s, 1.7 s, and 4.1 s. On the CPU the same read takes 10.2 s on the 0.8B and 22.7 s on the 2B, which is why the attachment budget stays at about 1,200 words and the chip says how much of a file was read.

The 4B is the first tier that behaves like an assistant, which is why it is recommended wherever the GPU can carry it. The rewrite template now carries a one-shot example so the smaller tiers rewrite instead of reply, and arithmetic never reaches the model.

**Thinking mode** (`THINK=1 node scripts/eval-models.mjs`, 0.8B, WebGPU, 600-token reasoning budget): about 6.8 s of visible thinking before the first answer token, then the same 92 tok/s. It fixed the two reasoning-shaped failures, 18% of 240 (43.2) and the bookmark sort (all three postings), and did not help the rewrite or the date extraction. Without the budget the 0.8B thought for 1,500 tokens and never answered, which is why the budget exists.

## Stack

- [WXT](https://wxt.dev) 0.21 for the extension build (Vite 8, MV3 manifest generation, Chrome and Firefox targets).
- [@wllama/wllama](https://github.com/ngxson/wllama) 3.6.1, pinned. llama.cpp compiled to WebAssembly with WebGPU offload.
- [tesseract.js](https://github.com/naptha/tesseract.js) 7 for the Notebook's on-device photo reading: worker, two SIMD cores, and English data copied into `public/tesseract/` by `scripts/gen-tesseract.mjs`, about 8 MB unpacked.
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
npm run site         # site/index.html for fogar.ai, plus the zip as site/fogar-chrome.zip
npm run web          # the web app into .output/web (vite.web.config.ts plus web/)
npm run test:web     # end-to-end check of the web app: isolation, storage, offline, the model from a web origin
npm run web:deploy   # build, then deploy the web app Worker to app.fogar.ai
```

Load the unpacked extension from `.output/chrome-mv3` at `chrome://extensions` with Developer mode on. Open a new tab.

After rebuilding, click Reload on the extension card (or bump the version). Chrome keeps the background service worker of an installed extension until the version changes or it is reloaded, so a rebuilt background script is otherwise ignored while pages load fresh. The same applies to persistent Playwright profiles: the eval profile runs an old background script; the e2e suite uses a fresh profile every run.

Smoke test variants: `HEADED=1` to watch it, `GPU=1` for the WebGPU path, `MODEL=qwen3-0.6b` to use the real 400 MB model, `VERBOSE=1` for every console line, `OCR=1` to also run Tesseract inside the extension on a rendered line of text (slow). The test also covers a warm OPFS reload and cloud mode against a local mock OpenAI server; the same mock stands in for Gmail, feeds, Jira, and the Anthropic Messages API for the widget checks.

`npm run build` first runs `npm run gen`, which regenerates `public/wllama/` from the pinned wllama package and `public/tesseract/` from tesseract.js, fetching the English language data (4 MB, from the tesseract-ocr project at a fixed tag) once and keeping it gzipped. Both directories are gitignored.

`npm run gen:icons` re-renders `public/icon/*.png` from the SVG mark in `scripts/gen-icons.mjs`.

`npm run site` builds fogar.ai into `site/`: the homepage from `site/page.html`, one page per use case from `site/src/*.html` (`/tabs`, `/bookmarks`, `/write`, `/voice`, `/today` live; `/ask`, `/search`, `/files`, `/models`, `/draw`, `/notebook`, `/news`, `/work` written and held until v0.1.1 is on the store, see `HOLD` in `scripts/build-site.mjs`; `FOGAR_SHOW_HELD=1 npm run site` builds them for a local preview), plus `sitemap.xml` and `robots.txt`. The homepage is the template: its styles, nav, install section, and footer are lifted out by `<!-- @nav -->`-style markers and shared with every page, so an edit there reaches all of them; each page carries its own title, description, canonical, Open Graph tags, and JSON-LD built from its FAQ. It also copies the current `.output/fogar-<version>-chrome.zip` to `site/fogar-chrome.zip`, which the install section keeps as a small fallback link for anyone who cannot use the store listing. Cloudflare serves `site/tabs.html` at `/tabs`, so links are extensionless. To publish: `npm run zip && npm run site && npx wrangler deploy`.

## The web app

The same page runs as an installable web app at [app.fogar.ai](https://app.fogar.ai). `npm run web` builds it with plain Vite (`vite.web.config.ts`) from the same `entrypoints/newtab` source: the `wxt/browser` import becomes `lib/web/browser-shim.ts` (storage over IndexedDB with change events, asset URLs, permission checks that say no, notifications through the web API), and nothing else in the page changes; `lib/platform.ts` tells the few places that differ which build they are in. `web/` holds the web-only files: the manifest and home-screen icons, `_headers` (cross-origin isolation for wllama's threads, and the same script policy as the extension), a service worker that precaches the page and the model runtime so the app opens and answers with no connection, and the registration script. `wrangler.app.jsonc` deploys it as a second assets-only Worker. `npm run test:web` builds it, serves it with those headers, and checks isolation, storage across a reload, the service worker with the server stopped, and the local model downloaded from a web origin and then loaded again with the network off.

What is different on the web. A page cannot make the cross-origin requests an extension's host permissions allow, so the Add menu does not offer Agenda, Feed, Inbox, Jira, or Sessions (`web: false` on the widget definition; a layout restored from a backup says so in their place). Bookmark search and the right-click question are extension features. Reminders fire only while the app is open, from the page itself, since there is no background worker or alarms API; the test notification asks for permission. Everything else is there.

On a phone. Open it once with a connection so the service worker can cache the app, then add it to the home screen (Safari: Share, then Add to Home Screen), which also exempts it from Safari's seven-day storage cleanup. The device check picks the 0.8B model, since Safari reports no memory figure; whether a phone's memory ceiling tolerates it is a matter of trying. The local model needs iOS 27: Safari 27 added the WebAssembly promise integration wllama's normal build relies on, and on iOS 26 wllama would reach for a slower compatibility build from a CDN, which this build does not ship. Cloud mode with your own key works on anything. Data lives in the browser on that device; a backup file from the extension restores into the app through Settings.

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
| pdf.js parses PDFs in a worker | a `blob:` worker would be refused | `lib/attachments.ts` imports the worker with Vite's `?url`, so it ships as a static module file on the extension's own origin; the parser chunk loads on the first PDF |
| tesseract.js spawns its worker from a `blob:` URL by default and fetches its core and language data from a CDN | both refused: remote code, and a blob worker | `scripts/gen-tesseract.mjs` copies the worker and two cores into `public/tesseract/` with the English data; `lib/ocr.ts` passes `workerBlobURL: false`, names the core file after a SIMD probe, and points `langPath` at the extension |
| Gmail's readonly scope is "restricted" for a published OAuth client | a Fogar-owned client would need a yearly security assessment | the Inbox widget reads Gmail's own unread feed with the browser's cookies, or uses an OAuth client the user creates in their own Google project; `identity` is an optional permission asked for at that moment |

The plugin and generator are pinned to the exact source text of wllama 3.6.1. Upgrading wllama makes the build fail with a message telling you what to update, rather than silently shipping a blob worker Chrome will block.

## Spike checklist

Results from 2026-09-21 on an M-series Mac, Playwright Chromium 153 (new headless), `npm run test:spike`:

- [x] Build produces an MV3 extension with no `blob:` worker in the newtab bundle
- [x] 1 MB test model downloads, loads, and streams tokens under the MV3 CSP
- [x] Warm reload of the same model makes zero GGUF downloads (weights served from OPFS). Two small Hugging Face repo-listing calls used to happen on every load, because wllama's `loadModelFromHF` lists the repo before it looks in the cache and `allowOffline` is never read in 3.6.1; since 2026-09-25 the loader goes straight to the file URL, the cache matches on it, and a cached model loads with the network off (`npm run test:web` checks exactly that)
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

Local mode makes no network requests after the model is cached. Cloud mode sends prompts only to the endpoint the user typed in. No analytics in the extension. This is also the cheapest possible Chrome Web Store data disclosure. The web app fetches its own files from app.fogar.ai and nothing else goes there; its data stays in that browser.

## License

MIT. See [LICENSE](LICENSE).

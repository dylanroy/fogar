# I put a language model inside a Chrome new tab page. Here is what broke.

*Draft for dylanroy.com, written 2026-09-29 from the outline in `docs/blog-1-the-build.md`. Every number is from the
README or the test suite. Things to check before publishing are listed at the end.*

---

Every new tab I open is a blank page asking me what I want. Fogar makes it answer back, from a model running on my
own machine: no account, no API key, no server. You type into the box, and a language model compiled to WebAssembly
answers from inside the page, whether or not you have a network connection.

It's [on the Chrome Web Store](https://chromewebstore.google.com/detail/fogar/cepnifpajfejaghhhaheadokfofcmoia)
now, and the [source is on GitHub](https://github.com/dylanroy/fogar). This post covers what it took to make that
work inside a Manifest V3 extension, which is mostly a list of the things Chrome would not let me do.

## What I built, and why

Fogar replaces the new tab page with an ask box. By default the answer comes from a model in the browser, through
[wllama](https://github.com/ngxson/wllama), which is llama.cpp compiled to WebAssembly. If you would rather use a
bigger model, you can point it at any OpenAI-compatible endpoint with your own key, and that key stays in the
browser.

I had two reasons, and I'll be honest about both. I wanted an assistant that doesn't send what I type anywhere. I
also wanted a small surface for my other projects: the footer links to them, and it says so. And it made a good
thing to write about.

The bet was that the hard part was already done. wllama 3 shipped WebGPU offload and caching in OPFS (the browser's
private file system), so inference in the browser works. The open question was whether an extension's sandbox would
allow any of it.

## Five things that broke

### 1. The package's entry point is TypeScript source

`@wllama/wllama` sets `"main"` to its TypeScript source, not a built file. Vite bundles that happily, which is
convenient right up until you try to patch the built bundle and nothing changes. Any transform has to target
`src/utils.ts`, not the built output. I lost an hour to this before a log line showed which file the bundler was
actually reading.

### 2. Manifest V3 refuses `blob:` workers, and wllama only makes `blob:` workers

The minimum script policy for an extension page is `script-src 'self' 'wasm-unsafe-eval'`. You can't add `blob:`,
`data:`, or `unsafe-eval` to it, and a manifest that tries is rejected at install.

wllama builds its worker's source as a string at runtime (the config as JSON, the emscripten glue, and the worker
loop), then starts it like this:

```ts
export const createWorker = (workerCode: string | Blob): Worker => {
  const workerURL = URL.createObjectURL(
    isString(workerCode)
      ? new Blob([workerCode], { type: 'text/javascript' })
      : (workerCode as Blob)
  );
  return new Worker(workerURL, { type: 'module' });
};
```

The fix is a small Vite plugin. A build script takes wllama's own exported code strings and writes them out as
static files inside the extension. The plugin then rewrites `createWorker` to start those files. The config that
used to be inlined into the worker's source now travels in the worker's URL and is read back with
`self.location.search`:

```ts
const m = code.match(/^const RUN_OPTIONS = (\{.*?\});/);
const opts = m ? JSON.parse(m[1]) : {};
opts.moduleUrl = base + 'module.js';
return new Worker(base + 'llama-worker.js?o=' + encodeURIComponent(JSON.stringify(opts)), { type: 'module' });
```

The plugin matches the original function's exact text, and wllama is pinned to an exact version. If a new release
changes that function, the build fails and names the file to update. I'd rather have that than ship a worker that
Chrome silently refuses.

### 3. Threads start threads, also from blobs

When `SharedArrayBuffer` is available, emscripten starts its thread workers from `mainScriptUrlOrBlob`, and wllama
passes a Blob there. It's the same wall as #2. Emscripten also accepts a string there, so the build script swaps in
the URL of the static `module.js`, and emscripten never calls `createObjectURL`.

`SharedArrayBuffer` itself requires cross-origin isolation. For an extension that's two manifest keys,
`cross_origin_embedder_policy` and `cross_origin_opener_policy`. With those set, the log reads
`Multithread enabled: true, pthreadPoolSize: 8`.

### 4. The bug I found by clicking twice

I clicked "Download and load" a second time while the first download was still running. wllama's OPFS writer runs
in its own worker and holds an exclusive handle to the file. Tearing down the first instance didn't release that
handle before the retry tried to delete the partial file, so the retry failed with `NoModificationAllowedError`.

The fix is boring: one load at a time, with the button disabled while one is running. The lesson is that the first
manual test finds what the automated tests can't, because the automated tests never double-click.

### 5. The model I should have started with

I started with Qwen3 0.6B because it was small. It told me Obama was president and that 18% of 240 is 432.

So I wrote an eval: load the extension in Playwright, run a fixed set of prompts per model, and record the time to
the first token, the tokens per second, and the text. Then I ran the three Qwen3.5 sizes. On WebGPU on an M-series
Mac:

| Model | Download | Warm load | Speed | Rewrite | 18% of 240 | Sort 6 bookmarks | Extract a date |
|---|---|---|---|---|---|---|---|
| Qwen3.5 0.8B | 533 MB | 1.3 s | 92 tok/s | replied instead | wrong | 1 of 3 wrong | wrong |
| Qwen3.5 2B | 1.3 GB | 1.8 s | 71 tok/s | replied instead | wrong | missed 1 | date wrong |
| Qwen3.5 4B | 2.7 GB | 3.2 s | 44 tok/s | right | right | right | right |

The 4B is the first one that behaves like an assistant. It rewrites a draft instead of replying to it, gets the
percentage right, sorts the bookmarks, and pulls out a date. The 2.7 GB file loaded as a single file, without
splitting. Fogar recommends a size based on what your machine can carry.

There are two lessons here. First, pick the model from measurements on the runtime you'll actually use, not from the
download size. Second, do the arithmetic yourself. No small model should be asked what 18% of 240 is, so in Fogar
arithmetic never reaches the model.

## What didn't break

- **Downloading 400 MB of weights from an extension page.** Weights are data, not code, so Manifest V3's rules
  against remote code don't apply to them. A host permission for huggingface.co was enough. It even works with
  cross-origin isolation switched on, because Hugging Face sends the CORS headers that isolation requires.
- **Caching in OPFS on a `chrome-extension://` origin.** A warm reload loads the whole model from disk and downloads
  nothing. The test suite checks this by counting requests to Hugging Face.
- **WebGPU inside an extension page.** The adapter reported Apple Metal 3 and every layer was offloaded to the GPU,
  even in Playwright's headless Chromium.

## Testing an extension that downloads 400 MB

Playwright's `launchPersistentContext` with `--load-extension` runs the real extension, and the new headless mode
supports extensions. You get the extension's id from its service worker's URL. A `?smoke=1` query on the new tab
page drives the whole flow, and a `data-status` attribute on `<body>` is what the test waits for. Reloading once and
counting Hugging Face responses proves the cache works. Pointing cloud mode at a 40-line mock OpenAI server proves
the streaming parser works.

With a 1 MB test model, the model part of the suite finishes in seconds. The suite has since grown to 83 checks
covering every widget, and it still runs with no real network.

## Widgets without code

Manifest V3 forbids running code from users, so "let people build widgets" became "let people configure typed
panels with data":

- **Agenda** is a pasted iCal URL plus a small parser for a subset of RFC 5545. Expanding recurring events was the
  fun part.
- **Weather** comes from Open-Meteo, which needs no key.
- **Recipes** are prompt forms stored as JSON, which you can share as a link.

The constraint made the product better. Nothing on the page can call out unless you typed the address it calls,
and a network ledger in Settings lists every request the page has made, so you can check.

## Since then

The store approved v0.1.0 on the first pass. Fogar also runs as an installable web app at
[app.fogar.ai](https://app.fogar.ai), built from the same source with the extension APIs swapped for a small shim.
A service worker caches the app and the model runtime, so it works offline on a phone. On iOS 26, wllama needs its
compatibility build (for browsers without JSPI), which is slower but works; iOS 27 runs the normal build.

Next up: sync across machines as the first paid feature, end-to-end encrypted with a passphrase Fogar never sees;
one shared model instance across tabs, so five open new tabs don't hold five copies of a 2 GB model; and a recipe
gallery once people make recipes worth sharing.

[Try Fogar](https://fogar.ai/?ref=dylanroy) · [Read the source](https://github.com/dylanroy/fogar)

---

## Before publishing

- **The "weekend" framing.** The outline's hook said "in one weekend". The repository's first commit is 2026-09-21,
  a Monday, and the spike closed that same day. This draft makes no time claim. Add one if it's true.
- **Hook numbers.** The Qwen3 0.6B anecdote (Obama, 432) is from the outline and isn't recorded in the README.
  Confirm you remember it that way.
- **Screenshots.** A first-screen shot and the network ledger would help. `npm run shots` makes them from the real
  extension.
- **Links.** The "Try Fogar" link uses `ref=dylanroy`, following the `ref=fogar` pattern the other products use. Change
  it or drop it as you prefer.
- **Title.** The other options from the outline: "Running llama.cpp inside a Manifest V3 extension"; "No key, no
  account, no server: an LLM in your new tab".

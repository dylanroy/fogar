# Launch posts

Drafts for Show HN, r/LocalLLaMA, and r/chrome_extensions, written 2026-09-29. Each title and body is in a plain text block: copy the inside of the block, and Reddit and HN render the Markdown (Reddit) or plain text (HN) themselves. Numbers are from the README; nothing here claims more than the blog post does.

## Before posting

- **Reddit rules.** I couldn't open Reddit from here, so check each subreddit's sidebar rules before posting. Both limit self-promotion. r/LocalLLaMA generally wants you to take part, not just post links, and may want a flair (probably "Resources" or "Other"). r/chrome_extensions usually wants a showcase flair.
- **Say it's yours, up front.** Each draft opens with "I built". Don't use a second account or ask anyone to vote. HN flags that, and Reddit removes it.
- **The two questions you'll get, answered before anyone asks:** the footer that links to your other products, and the Cloudflare beacon on app.fogar.ai. Both are disclosed in the posts below. A privacy-focused crowd forgives what you disclose and punishes what they find on their own.
- **Timing.** Post Show HN on a weekday morning, US Pacific time, and stay for the first two or three hours to answer comments. Space the two Reddit posts a day or so apart, not all at once.
- **Numbers to have ready.** The model table from the README; 83 end-to-end checks; permissions listed in the privacy policy at fogar.ai/privacy.

---

## Show HN

**Title** (HN allows 80 characters):

```text
Show HN: Fogar – A Chrome new tab that runs an LLM locally, no key or account
```

**URL:** https://github.com/dylanroy/fogar

HN's rules say not to post landing pages, and people can read the code, so the repo is the right link. The store listing and the web app go in your first comment.

**First comment** (post it right after submitting):

```text
I built Fogar because I had dozens of tabs open and was afraid to close any of them. It replaced my new tab page with one that saves a window so I can close it, and finds any tab again as I type, open or saved. Since that page was open all day, I made it answer questions too, from a model running in the browser.

It uses wllama (llama.cpp compiled to WebAssembly) inside a Manifest V3 extension. After the model is downloaded once, nothing you type leaves the machine, and a network ledger in Settings lists every request the page has made. You can also point it at any OpenAI-compatible endpoint with your own key.

Getting it to run in MV3 was the interesting part. The extension script policy refuses blob: workers, and wllama creates all its workers from blobs, including emscripten's thread workers. So a Vite plugin rewrites wllama's createWorker to start static files instead, and the build fails if the pinned wllama version changes that function. SharedArrayBuffer needs cross-origin isolation, which for an extension is two manifest keys. Full write-up: https://dylanroy.com/i-put-a-language-model-inside-a-chrome-new-tab-page-here-is-what-broke/

Measured on WebGPU on an M-series Mac: Qwen3.5 0.8B at 92 tok/s, 2B at 71, 4B at 44. The 4B is the first size that behaves like an assistant (it rewrites a draft instead of replying to it), so Fogar recommends a size based on the machine. Arithmetic never goes to the model.

To be upfront about two things: the page footer links to my other products, and says so; and the web app at app.fogar.ai carries Cloudflare's cookie-free page-view beacon, which the network ledger shows and Settings mentions. The extension itself has no analytics.

Chrome Web Store: https://chromewebstore.google.com/detail/fogar/cepnifpajfejaghhhaheadokfofcmoia. To try it without installing anything, open app.fogar.ai in a desktop browser. Everything that runs on your machine is free. I'm here to answer questions.
```

---

## r/LocalLLaMA

This crowd cares about the runtime, the models, and the numbers, so lead with those.

**Title:**

```text
I got llama.cpp running inside a Chrome extension's new tab page: Qwen3.5 4B at 44 tok/s on WebGPU, fully offline after the first download
```

**Body:**

```text
I built a Chrome extension, Fogar, that replaces the new tab page with an ask box answered by a model in the browser. It uses wllama (llama.cpp compiled to WebAssembly) with WebGPU offload and caches the model in OPFS, so after the first download it answers with no network. It's free and open source: https://github.com/dylanroy/fogar

Measured on WebGPU on an M-series Mac, all Q4:

| Model | Download | Warm load | Speed | Rewrites a draft? | 18% of 240 |
|---|---|---|---|---|---|
| Qwen3.5 0.8B | 533 MB | 1.3 s | 92 tok/s | replied instead | wrong |
| Qwen3.5 2B | 1.3 GB | 1.8 s | 71 tok/s | replied instead | wrong |
| Qwen3.5 4B | 2.7 GB | 3.2 s | 44 tok/s | yes | right |

The 4B is the first size that behaves like an assistant, so Fogar recommends a size based on the machine and falls back to the CPU without WebGPU. Arithmetic is worked out on the page and never reaches the model. Attached files go into the prompt too: on the 4B, a 915-word letter costs about 4 s to the first token on WebGPU.

The hard part was Manifest V3. Extension pages can't run blob: workers, and wllama creates every worker from a blob, including emscripten's thread workers. A Vite plugin rewrites wllama's createWorker to start static files instead. Cross-origin isolation for SharedArrayBuffer is two manifest keys, which gets you 8 threads. Write-up with the details: https://dylanroy.com/i-put-a-language-model-inside-a-chrome-new-tab-page-here-is-what-broke/

You can also point it at Ollama, LM Studio, or any OpenAI-compatible endpoint. The eval harness is in the repo (scripts/eval-models.mjs), if you want to run your own models through it.

What I'd like feedback on: which small models you'd put in the tiers today, and whether anyone has found a sub-2B model that reliably rewrites instead of replying.

Store: https://chromewebstore.google.com/detail/fogar/cepnifpajfejaghhhaheadokfofcmoia. There's also a web version at app.fogar.ai that works offline on a phone. It carries Cloudflare's cookie-free page-view beacon, which the network ledger shows; the extension has no analytics.
```

---

## r/chrome_extensions

This crowd is extension users and builders, so lead with what it does, and give permissions their own section.

**Title:**

```text
I built a new tab page that saves your tabs, finds them as you type, and answers questions with an AI that runs on your computer
```

**Body:**

```text
I had dozens of tabs open because closing one felt like losing it, so I built Fogar, a new tab page for Chrome. It's free and open source.

- **Tabs:** save a window (or all of them) and close it; search saved and open tabs as you type, and switch to a tab that's already open instead of opening it again.
- **An ask box** answered by a model running in your browser. After it downloads once (533 MB to 2.7 GB, sized to your machine), it works offline and nothing you type leaves your computer. Or point it at any OpenAI-compatible endpoint with your own key: OpenAI, OpenRouter, Groq, or Ollama on your machine. (The LLM Chat widget also talks to Anthropic and Gemini.)
- **Widgets:** todos, reminders, links, notes, weather, calendar (from an iCal link), RSS, a whiteboard, sticky notes, and a writing assistant that learns your voice from samples.
- **Bookmark search** as you type, plus "find the bookmark about…" in plain language.

On permissions, since this sub rightly cares: tabs is optional and asked for only when you add the Sessions widget, because Chrome labels it "Read your browsing history". Cloud endpoints and other sites are asked for one at a time, when you add them. There are no analytics in the extension, and a network ledger in Settings lists every request the page has made. The full list, with a reason for each, is at fogar.ai/privacy.

The footer links to my other projects, and says so.

Store: https://chromewebstore.google.com/detail/fogar/cepnifpajfejaghhhaheadokfofcmoia
Source: https://github.com/dylanroy/fogar
How I got a language model running inside a Manifest V3 extension: https://dylanroy.com/i-put-a-language-model-inside-a-chrome-new-tab-page-here-is-what-broke/

I'd love feedback, especially on what feels missing from a new tab page you'd actually keep.
```

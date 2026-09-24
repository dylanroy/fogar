# Fogar roadmap

Last updated 2026-09-24. Status of each item is in the checkbox. Dates are when a phase closed, not when it was planned.

## The filter

Every proposed feature passes these five or it does not ship.

1. **Nothing leaves the room unless the user points it somewhere.** Local mode makes no requests after the model is cached. Every outbound call goes to an address the user typed. Proposed and undecided (see [docs/pro-sync-admin-plan.md](docs/pro-sync-admin-plan.md), §5.2): one anonymous fetch a day of `fogar.ai/catalog.json`, which says which widgets are part of Pro, behind a switch in Settings.
2. **Data, never code, for anything users create or share.** Recipes and future widgets are JSON the extension renders. Manifest V3 enforces this anyway; we treat it as a product principle, not a limitation.
3. **Every permission fits in one sentence on the store listing.** No `history`, no `tabs` unless a feature cannot exist without it.
4. **Free for everything that runs on your machine.** Pro is one paid tier for features that need a server, sync across machines first. No trials, no lifetime deals, no accounts unless you buy Pro, no analytics either way. The footer rotates Dylan's products; a labeled sponsor line may appear later. (Rewritten 2026-09-23 from "Free. No tiers." when sync became the first Pro feature; the plan is in [docs/pro-sync-admin-plan.md](docs/pro-sync-admin-plan.md).)
5. **Every feature has an end-to-end check** in `npm run test:spike`, which loads the built extension into Chromium and drives it.

## Done

### Phase 1: spike (closed 2026-09-21)
- [x] wllama runs inside a Manifest V3 extension page. Blob workers rewritten to static files; pthread entry swapped to a static URL; COOP/COEP manifest keys for SharedArrayBuffer.
- [x] Qwen3 0.6B Q4: 397 MB cold, 1.3 s warm from OPFS, first token 355 ms, 104 tok/s on CPU with 8 threads. WebGPU confirmed on Metal.

### Phase 2: product (closed 2026-09-21)
- [x] First-run chooser, cached model auto-loads on every new tab, stop button, plain web search before a model is ready, right-click "Ask Fogar about …", cache size and clear, icons, redesign with dark mode.

### Phase 3: your corner (closed 2026-09-21)
- [x] Opt-in web grounding with a Brave Search or Tavily key. Citations and sources. Keyless default added 2026-09-21: DuckDuckGo Instant Answer API plus Wikipedia. Tightened 2026-09-23 after "Give me some bullets from the document" came back citing Tupac Shakur and body armor standards: a question about an attached file skips the search (the toggle rests while a file is attached; Dig deeper still offers it, and the results then add to the file rather than replace it, with the prompt saying so); Wikipedia pages that matched on body text alone are dropped, a page counting only when its title or opening lines name a word of the question, and disambiguation stubs go too; sources are listed only when the answer cites them, the stats line saying "4 web results, none cited" or "no relevant web results" otherwise; and a grounded re-ask keeps the conversation as it was cut for the file instead of putting the whole history back.
- [x] Recipes: data-only prompt forms with a builder, import, export, and share links. Four built-ins.
- [x] Todos. Reminders with a plain-language parser, confirmation, `chrome.alarms`, notifications, and a zero-permission Google Calendar link.
- [x] Bookmark search as you type, and a natural-language bookmark finder that has the model classify the list.
- [x] Landing page draft in `site/`.

### Phase 3c: Sessions (closed 2026-09-22)
- [x] Sessions widget: save open windows (per window or all, with or without closing), duplicates collapsed, auto-named from date and top sites; ranked search in the widget and from the ask bar over saved tabs and tabs that are open right now, open hits first and switched to rather than reopened, an address that is both listed once; restore a window or a session with tabs created discarded; promote a tab or a whole session into an "Other bookmarks" folder named after it; rename, remove tabs, delete; export one or all as Markdown, a Netscape bookmarks file, or a Fogar file, plus copy links. Optional `tabs` permission requested when the widget is added. Sessions ride along in backups.
- [ ] Safety net: an automatic snapshot of every open tab every ten minutes, keeping recent hours and days, so a crash or an over-eager cleanup is recoverable without pressing Save. Plus candidate.
- [ ] Model-assisted: "find the tab about …" over saved tabs (the bookmark finder's machinery), and "sort this session into folders" proposing named groups that become bookmark folders or tab groups in one click. Plus candidate.

### Phase 3b: the assistant, not the demo (closed 2026-09-21)
- [x] Qwen3.5 tiers (0.8B, 2B, 4B) with a device-based recommendation; thinking off; CPU fallback. Eval harness and numbers in the README.
- [x] Follow-ups with conversation history; Markdown answers; older exchanges collapse.
- [x] Ask-bar routing: URL, search prefix, "remind me", "todo:", arithmetic, bookmarks, model. Example chips. Factual-question nudge.
- [x] Network ledger; backup and restore.
- [x] Widgets as data: Agenda (iCal), Todos, Reminders, Links, Notes, Weather, Recipe. Reorder, configure, remove, add. Focus mode.
- [x] Privacy policy, store listing copy, generated store assets, zipped build.
- [x] Right-click questions carry the page (activeTab + scripting, session storage hand-off). "Dig deeper" on answers: search again, think longer (600-token budget), ask the other model; re-asks replace the exchange. Honesty line in the system prompt. Test build variant (WXT_E2E=1) so the suite exercises the real right-click path.

### Phase 3c: make it yours (closed 2026-09-22)
- [x] Customize popover: appearance override, curated accents plus a hue slider, paper tint, heading face, density; layout: ask box placement, sidebar arrangement for wide windows, widget columns, recipes row. Reset. Theme share links. Drag widgets to reorder (arrows kept for keyboards).
- [x] Themes as data: OKLCH tokens derived from four numbers, so no theme can be unreadable. Boot script paints the saved theme before first paint. Backup carries the theme.

### Phase 3d: the first screen, and files (closed 2026-09-23)
- [x] The first screen, after a look at how chat products open. The placeholder is one quoted example (`e.g. "Draft a polite no to a meeting invite"`), a different one per tab, in place of a list of capabilities that also over-promised for a small model. The four example chips draw from a pool of ten covering every route the box knows: writing tasks only once a model can answer, bookmarks and open tabs only when available. A fifth chip, "What can I type here?", opens a static card with the routing rules; a model answer there would invent features. The "Rewrite my draft" chip that duplicated the Draft & rewrite recipe is gone.
- [x] Attachments. Drop a file anywhere on the page, press + in the box, or paste one. PDF through pdf.js (text layer only, read page by page until the budget is full), Word `.docx` unzipped in the page, HTML, and plain text of any kind. The text goes in the system prompt with the same "say when the file does not contain the answer" line as a right-click page, stays for follow-ups and Dig deeper, leaves with New conversation, and is never written to storage or backups. The chip says how much was read: "12 pages · read the first 3". Budget on this device 6,500 characters, about 1,200 words, so the 4,096-token window still holds the conversation and a 768-token answer; 40,000 in cloud mode. Recipe fields take a dropped file too. No new permission, and nothing leaves the browser in local mode; the eval has a document case (`document` in `scripts/eval-models.mjs`) so prefill time is a measured number: on WebGPU a 915-word letter costs 0.9 s, 1.7 s, and 4.1 s to the first token on the 0.8B, 2B, and 4B, all three answering correctly; on the CPU, 10 s and 23 s for the 0.8B and 2B.
- [x] The attach and send controls live inside the box now, so the row below is only the status line and the web toggle; the field grows with the text instead of carrying a drag handle. Status in plain words: "Ready · Qwen3.5 4B · on your GPU".

### Phase 3e: seven widgets and full screen (closed 2026-09-23)
- [x] Inbox: Gmail's unread feed for the signed-in account (a label as the filter), or the Gmail API through the user's own OAuth client (any search). Fogar never holds a Google scope of its own; `identity` is an optional permission asked for at connect time.
- [x] Feed: RSS 2.0, Atom, RSS 1.0, JSON Feed, feed autodiscovery from a site address, and searches as feeds (Google News, Hacker News, Reddit, Bing News), merged newest first, deduped by address, a dot on what is new, "Mark read".
- [x] Jira: one JQL query with the user's API token (Cloud: email + token as Basic; Server and Data Center: a personal access token as Bearer). Read-only.
- [x] LLM Chat: the device model, the Settings endpoint, or saved profiles (Anthropic through the Messages API, OpenAI, OpenRouter, Gemini, Groq, Ollama, LM Studio, custom). Models fetched from the endpoint; conversations persist per widget; profiles shared across widgets.
- [x] Canvas: pen, highlighter, arrows, lines, boxes, ellipses, text, eraser, undo and redo, PNG export. "Draw a house" goes to the model with the shapes as data; the reply is a validated shape list; the user's strokes travel by id and come back untouched.
- [x] Notebook: ruled pages with tabs; a photo becomes text through Tesseract inside the extension (English, printed text) or a vision-capable chat profile (handwriting). Photos are downscaled and never stored.
- [x] Post-its: sticky notes on a board, dragged by their top edge; a note dropped on another board moves there, a note dropped on any other card becomes its own widget beside it.
- [x] Full screen for every widget (a fixed overlay, Escape to leave; boards and canvases fill the window, lists keep a readable column). Not persisted.
- [x] Widget tiers: `lib/catalog.ts` names each widget free or Pro (all free today); the Add menu shows a Pro tag and a lock the day one flips. Scaffolding for the plan below.

### Phase 3f: writing in your voice (closed 2026-09-24)
- [x] Writing widget: the Draft & rewrite recipe, but it knows who is writing. Samples of the user's real writing (typed, pasted, or dropped as files) are distilled once, by the model picked in the widget's header, into a voice profile under six headings (diction, sentence rhythm, structural habits, tics with their frequency, baseline intensity, what the author would never do), versioned and editable as plain text. Four operations from the Dickens prototype: rewrite, tighten, warmer, draft. Registers are modes under one voice, never separate voices: Email, Chat, and Essay seeded, any number added, each with a formality, a length, and rules the prompt says to follow exactly; a "no em dashes" rule is also enforced deterministically after generation, because models do not obey it reliably. Model from the header: the device model, the Settings endpoint, or an LLM Chat profile. Budgets keep the local 4,096-token window honest (about 1,000 words of samples per distill, a 300-word profile, two pages of text per run) and the widget says when a sample did not fit. One widget is one voice. Data lives at `fogar.widget.<id>`, so backups carry it. A `/voice` page on fogar.ai, linked from the Use cases menu, the homepage, the footer, and `/write`. The card credits Dickens (dickens.ai), the voice engine it is a light version of, with a link in its corner; the page says the same in one line.
- [x] Writing, the Dickens loop: samples open in full and save edited (text and where it came from); a checkbox per sample decides what a distill reads, which also picks what fits the local window; the Voice view counts changes to the samples since the profile was built and says so, and the Distill button steps back when there is nothing new. Corrections, one line each, go after the profile on every run and into the distill prompt as things the profile must not contradict; "Not me?" on a result goes straight to them. Distilling again keeps the version it replaces (five kept, restorable), so hand edits to a profile are never lost.
- [x] Customize: four widget columns (they fold to two below 1,100 px and to one below 760 px) and a page width of normal, wide, or full; the sidebar rail widens with it. Widget cards are one column no wider than the card, and a long header control (the Writing model picker) wraps under the title instead of pushing the body past the edge.
- [ ] Next, if asked: a "Rewrite in my voice" route in the ask bar and the right-click menu once a voice exists; few-shot grafting (raw samples in the run prompt) as the dial to turn if a profile alone reads generic, per the Dickens notes; one voice shared by several widgets of the same author.

## Now: release candidate, v0.1

The goal is a listing that gets approved on the first pass and a page that is true the day it goes live.

- [x] WebGPU numbers for all three tiers in the README and on the landing page (Chromium 153 headless with Metal; real Chrome headless did not expose the extension service worker to Playwright, so these are the closest honest numbers).
- [ ] Notifications on macOS: confirm Chrome has system notification permission in the first-run copy, since reminders are silent without it.
- [x] Privacy policy page at `site/privacy.html`.
- [x] Store listing copy in `store/listing.md`; screenshots and promo tiles generated by `scripts/store-assets.mjs` from the real extension.
- [x] `wxt zip` produces the store package in `.output/`.
- [x] Submit to the store. v0.1.0 approved and live at chromewebstore.google.com/detail/fogar/cepnifpajfejaghhhaheadokfofcmoia (2026-09-24); v0.1.1 (Writing corrections and sample editing, Todos drag, four columns and page width) uploaded for review the same day. v0.1.1 adds the optional `identity` permission for the Email widget's Gmail connection, which the dashboard's privacy tab justifies.
- [x] fogar.ai points every Add to Chrome button at the store listing, and the JSON-LD `downloadUrl` and `installUrl` with them. The install section now walks people who loaded the zip through moving their data to the store copy (backup, install, restore); the zip stays as a small fallback link (2026-09-24).
- [x] Public GitHub repo: github.com/dylanroy/fogar (2026-09-22). The landing page's "Get the source" button points at it.
- [x] Landing page offers the built zip as a direct download, fogar.ai/fogar-chrome.zip, with unzip / Developer mode / Load unpacked steps in place of the clone-and-build block, until the store listing exists (2026-09-22). `npm run site` copies the zip from `.output/`; it is not committed.
- [x] Use-case pages on fogar.ai: `/tabs`, `/bookmarks`, `/write`, `/today`, one per search intent, each with its own demo, ledger, straight talk, and FAQ. Linked from a Use cases menu in the nav, a card row on the homepage, and the footer. `sitemap.xml`, `robots.txt`, canonical and Open Graph tags, JSON-LD (2026-09-22). www.fogar.ai redirects to the apex with a 301 through a Cloudflare Redirect Rule (the “Redirect from WWW to root” template, added in the dashboard 2026-09-22), since both hostnames reach the Worker. Plain HTTP is still served rather than redirected: the zone's Always Use HTTPS setting is off.
- [x] fogar.ai on Cloudflare (Dylan); `site/` deployed as an assets-only Worker (`wrangler.jsonc`, `npx wrangler deploy`) with edge routes for fogar.ai and www.fogar.ai, since the zone's imported parking records block Worker custom domains (2026-09-22).
- [ ] Recipe assistant: "Describe the recipe you want" and the model drafts the JSON, validated and opened in the existing editor. Worth doing once the 4B is the common tier; the smaller ones will not produce valid JSON reliably (see the eval).

## Next: Pro, and sync across machines

The first paid feature and the account it needs, planned in [docs/pro-sync-admin-plan.md](docs/pro-sync-admin-plan.md): an email and a Stripe subscription; data encrypted on the device with a passphrase Fogar never sees; a Cloudflare Worker with D1 holding blobs it cannot open; per-key merge with tombstones built on the backup merge that already exists; an `/admin` page behind Cloudflare Access that flips widgets between Free and Pro without a store release. Order of work: account and billing, sync, admin and catalog, launch. Open decisions listed in the plan: price, whether keys sync (recommended: yes, encrypted), how a free install learns about a catalog change (recommended: one anonymous daily fetch behind a switch), which widgets go Pro on day one.

## Next: launch, v0.2

- [ ] Publish blog post one on dylanroy.com the same day the listing goes live. Outline is in `docs/blog-1-the-build.md`.
- [ ] Show HN, r/LocalLLaMA, r/chrome_extensions. The hook is "no key, no account, no server".
- [ ] Triage feedback for two weeks before building anything new.
- [ ] Measurement is store-side only: installs, weekly users, uninstall rate. Footer links carry `ref=fogar` so each product's own analytics show what the slot sends. No telemetry in the extension, ever.

## Later: the recipe gallery

This is the answer to "should we build a widget marketplace". Yes, in this shape, and not yet.

**What it is.** A page on fogar.ai listing recipes, each with a one-click "Add to Fogar" share link, an author credit, and a short description. Recipes are JSON, so the gallery is a static index file in this repo. Submissions arrive as pull requests or a form that opens one. Dylan curates; there is no upload button.

**Why it works without accounts.** Adding a recipe is a link. Author credit is a link back to the author. That is the growth loop: people who write a good recipe share their gallery link, which lands on fogar.ai, which installs Fogar. No ratings, no comments, no logins. If the gallery ever needs those, it needs a backend, and the case for that would have to be made from real demand.

**What it will not be.** A store. Recipes stay free. Selling them would need licensing, which needs accounts, which contradicts principle 4. Sponsored placement in the gallery is fine and labeled, same rule as the footer.

**Gate.** Twenty user-made recipes shared or requested, or a month of people asking. Before that, the four built-ins plus import are enough.

## Shipped: declarative widgets

Done on 2026-09-21: Agenda, Todos, Reminders, Links, Notes, Weather, and Recipe as typed widgets configured with data; reorder, configure, remove, add; Focus mode. Todos and Reminders are the first two panels in the system, so the layout is user-controlled from the start. Still no user code. On 2026-09-23: Inbox, Feed, Jira, LLM Chat, Canvas, Notebook, Post-its, and full screen for all of them (Phase 3e above). On 2026-09-24: Writing, in the user's own voice, with registers (Phase 3f).

**Next for widgets, if asked:** Countdown, Clock, a GitHub notifications panel with a personal token, other languages for the Notebook's on-device reader (fetched from tesseract's CDN with a permission prompt, like model weights). Each is a config form plus a render function.

## Later: integrations and the agenda widget

Dylan's ask: connect Google Calendar and show a daily agenda on the new tab. That is one of the best things a new tab can do, and it fits the filter as long as the connection is explicit and read-only. Two steps.

**Step 1, agenda from a calendar feed (no OAuth).** Every major calendar publishes a private iCal (ICS) URL: Google's "Secret address in iCal format", Outlook's "Publish calendar", iCloud's public sharing. The user pastes the URL, Fogar requests that one origin as an optional host permission, fetches and parses the feed, and renders today and tomorrow as a panel. Works for every provider on day one, needs no Google review, and the URL lives in extension storage like an API key. Feeds refresh on the provider's schedule, so events can lag by minutes to an hour, which is fine for an agenda and wrong for alarms.

**Step 2, Google Calendar OAuth, read-only.** `chrome.identity` with the `calendar.readonly` scope. That scope is "sensitive", which means Google's OAuth verification (privacy policy, homepage, a demo video, a scope justification; usually weeks) but not the annual third-party security assessment that "restricted" scopes like Gmail require. Verification can run in parallel with the store review. Once approved: live data, no URL to paste, and the option to write reminders into the calendar instead of the template link. The connect button is opt-in and the event data never goes anywhere but the page.

**The pattern for everything else.** An integration is a URL or a token the user pastes, stored locally, sent only to its own origin, requested as an optional permission at save time. Cloud mode and grounding already work this way. Candidates that fit: RSS feeds as a reading panel, weather from Open-Meteo (no key needed), GitHub notifications with a personal token. Each is a declarative widget type with a config form, same as recipes.

**Status.** Step 1 shipped on 2026-09-21 as the Agenda widget. Step 2 starts the day the store listing is submitted, because the verification clock is the long one.

## Later, if asked

- **Speech to text, locally.** Chrome's on-device recognition mode of the Web Speech API (needs a spike: does it run from an extension page, which languages), or Whisper in WebAssembly as a second cached model of 75 to 150 MB. The microphone is a runtime prompt on the page, not an install-time permission, so the listing stays clean. The angle that would justify it is dictation for writing tasks: say it messy, let the rewrite recipe make it clean. Only after the launch triage shows people asking.
- **Attachments, further.** OCR for scans and images in the ask bar: the Notebook widget now ships Tesseract with English data (8 MB), so attaching a scan is a matter of routing it through `lib/ocr.ts`. Also spreadsheets, PDFs with CJK fonts (pdf.js needs its cmaps shipped), and an 8k context on the WebGPU tiers so a longer document fits. Each is a measured memory or time cost; none is a new permission.
- **One shared model instance across tabs** through an offscreen document, so several open new tabs do not each hold 0.5 to 2.7 GB. The most likely cause of uninstalls once people keep several new tabs open; the highest-value engineering item left. **Spiked on branch `spike/offscreen-model` (2026-09-21): an offscreen document gets WebGPU (Apple, metal-3), SharedArrayBuffer, and cross-origin isolation, and loads and generates. What remains is the plumbing: a port-based provider in the page, load/ask/abort messages, progress and token events, and an idle unload.**
- ~~`storage.sync` for todos and reminders across a Chrome profile.~~ Superseded by the Pro sync plan, which is end-to-end encrypted and not tied to a Google account.
- Ollama auto-detect on localhost as a one-click cloud option.
- Firefox. It builds today, but extension pages lack SharedArrayBuffer there, so it would be single-threaded. Ship only if the WebGPU path makes that irrelevant.
- ~~Tab search from the ask bar.~~ Superseded by the Sessions widget, which takes the `tabs` permission as an optional grant when the widget is added.
- More widget types: Countdown, Clock, an RSS reading list, GitHub notifications with a personal token.

## Decided against

- **Speech to text through the default Web Speech API.** Chrome streams the audio to Google's servers, which breaks principle 1, and the request happens inside the browser where the network ledger cannot show it. The local routes are under "Later, if asked".
- **A name greeting on the first screen.** Chat products with accounts open with "How can I help you, Chhavi?". Fogar has no account, the date line already anchors the page, and an optional name would be one more setting for a line of warmth that reads as the Momentum cliché.
- **Moving the Ask button inside the box on its own.** The row below has to exist for the status line and the web toggle, so the move alone saved nothing; it happened together with the attach button, as a set (Phase 3d).
- **User-authored widgets as code.** Manifest V3 bars it; recipes and declarative widgets cover the real need.
- **A Fogar-owned Gmail OAuth client.** Gmail's scopes are "restricted", which means an annual third-party security assessment on top of verification. The Inbox widget (2026-09-23) reads Gmail's own unread feed with the browser's cookies, or uses an OAuth client the user creates in their own Google project, so Fogar never holds the scope. Calendar is different and is on the roadmap above.
- **Lifetime deals, trials, and charging for anything that runs on your machine.** Pro (2026-09-23) is for features that need a server, sync first; everything local stays free.
- **Analytics in the extension.** Contradicts the pitch and complicates the listing.
- **Arbitrary CSS themes and wallpapers.** Not a Chrome rule, a quality one: free CSS breaks contrast and dark mode and looks like user code to a reviewer; wallpapers pull the design toward a screensaver. Themes are parameters instead.
- **Scraping a search engine for grounding.** Breaks, violates terms, and gets store listings pulled. DuckDuckGo's Instant Answer API and Wikipedia's API are official, keyless, and CORS-open, so they are the free tier; DuckDuckGo's web results have no API and are not scraped. Full web results stay bring-your-own key.
- **The `history` permission.** Scares people at install and invites review trouble. Bookmarks are enough.
- **The `tabs` permission at install.** Chrome labels it "Read your browsing history". It exists only as an optional permission, asked for when someone adds the Sessions widget, with the reason stated in the widget.

## Sponsor slot rules

- The "Sponsor this slot" page goes live only after roughly 2,000 weekly active users in the store dashboard. Below that the price is not worth the negotiation.
- One line in the footer, labeled "Sponsored", a plain link with a `ref` parameter. No pixels, no scripts, no rotation by user data.
- Own products otherwise. Never an ad network.

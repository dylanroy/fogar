# Fogar roadmap

Last updated 2026-09-21 (evening). Status of each item is in the checkbox. Dates are when a phase closed, not when it was planned.

## The filter

Every proposed feature passes these five or it does not ship.

1. **Nothing leaves the room unless the user points it somewhere.** Local mode makes no requests after the model is cached. Every outbound call goes to an address the user typed.
2. **Data, never code, for anything users create or share.** Recipes and future widgets are JSON the extension renders. Manifest V3 enforces this anyway; we treat it as a product principle, not a limitation.
3. **Every permission fits in one sentence on the store listing.** No `history`, no `tabs` unless a feature cannot exist without it.
4. **Free.** The footer rotates Dylan's products; a labeled sponsor line may appear later. No tiers, no trials, no lifetime deals, no accounts.
5. **Every feature has an end-to-end check** in `npm run test:spike`, which loads the built extension into Chromium and drives it.

## Done

### Phase 1: spike (closed 2026-09-21)
- [x] wllama runs inside a Manifest V3 extension page. Blob workers rewritten to static files; pthread entry swapped to a static URL; COOP/COEP manifest keys for SharedArrayBuffer.
- [x] Qwen3 0.6B Q4: 397 MB cold, 1.3 s warm from OPFS, first token 355 ms, 104 tok/s on CPU with 8 threads. WebGPU confirmed on Metal.

### Phase 2: product (closed 2026-09-21)
- [x] First-run chooser, cached model auto-loads on every new tab, stop button, plain web search before a model is ready, right-click "Ask Fogar about …", cache size and clear, icons, redesign with dark mode.

### Phase 3: your corner (closed 2026-09-21)
- [x] Opt-in web grounding with a Brave Search or Tavily key. Citations and sources. Keyless default added 2026-09-21: DuckDuckGo Instant Answer API plus Wikipedia.
- [x] Recipes: data-only prompt forms with a builder, import, export, and share links. Four built-ins.
- [x] Todos. Reminders with a plain-language parser, confirmation, `chrome.alarms`, notifications, and a zero-permission Google Calendar link.
- [x] Bookmark search as you type, and a natural-language bookmark finder that has the model classify the list.
- [x] Landing page draft in `site/`.

### Phase 3c: Sessions (closed 2026-09-22)
- [x] Sessions widget: save open windows (per window or all, with or without closing), duplicates collapsed, auto-named from date and top sites; ranked search in the widget and from the ask bar; restore a window or a session with tabs created discarded; promote a tab or a whole session into an "Other bookmarks" folder named after it; rename, remove tabs, delete; export one or all as Markdown, a Netscape bookmarks file, or a Fogar file, plus copy links. Optional `tabs` permission requested when the widget is added. Sessions ride along in backups.
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

## Now: release candidate, v0.1

The goal is a listing that gets approved on the first pass and a page that is true the day it goes live.

- [x] WebGPU numbers for all three tiers in the README and on the landing page (Chromium 153 headless with Metal; real Chrome headless did not expose the extension service worker to Playwright, so these are the closest honest numbers).
- [ ] Notifications on macOS: confirm Chrome has system notification permission in the first-run copy, since reminders are silent without it.
- [x] Privacy policy page at `site/privacy.html`.
- [x] Store listing copy in `store/listing.md`; screenshots and promo tiles generated by `scripts/store-assets.mjs` from the real extension.
- [x] `wxt zip` produces the store package in `.output/`.
- [ ] Submit to the store. New-tab overrides get extra review; expect days to weeks. Needs Dylan's developer account.
- [x] Public GitHub repo: github.com/dylanroy/fogar (2026-09-22). The landing page's "Get the source" button points at it.
- [x] fogar.ai on Cloudflare (Dylan); `site/` deployed as an assets-only Worker (`wrangler.jsonc`, `npx wrangler deploy`) with edge routes for fogar.ai and www.fogar.ai, since the zone's imported parking records block Worker custom domains (2026-09-22).
- [ ] Recipe assistant: "Describe the recipe you want" and the model drafts the JSON, validated and opened in the existing editor. Worth doing once the 4B is the common tier; the smaller ones will not produce valid JSON reliably (see the eval).

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

Done on 2026-09-21: Agenda, Todos, Reminders, Links, Notes, Weather, and Recipe as typed widgets configured with data; reorder, configure, remove, add; Focus mode. Todos and Reminders are the first two panels in the system, so the layout is user-controlled from the start. Still no user code.

**Next for widgets, if asked:** Countdown, Clock, an RSS reading list, a GitHub notifications panel with a personal token. Each is a config form plus a render function.

## Later: integrations and the agenda widget

Dylan's ask: connect Google Calendar and show a daily agenda on the new tab. That is one of the best things a new tab can do, and it fits the filter as long as the connection is explicit and read-only. Two steps.

**Step 1, agenda from a calendar feed (no OAuth).** Every major calendar publishes a private iCal (ICS) URL: Google's "Secret address in iCal format", Outlook's "Publish calendar", iCloud's public sharing. The user pastes the URL, Fogar requests that one origin as an optional host permission, fetches and parses the feed, and renders today and tomorrow as a panel. Works for every provider on day one, needs no Google review, and the URL lives in extension storage like an API key. Feeds refresh on the provider's schedule, so events can lag by minutes to an hour, which is fine for an agenda and wrong for alarms.

**Step 2, Google Calendar OAuth, read-only.** `chrome.identity` with the `calendar.readonly` scope. That scope is "sensitive", which means Google's OAuth verification (privacy policy, homepage, a demo video, a scope justification; usually weeks) but not the annual third-party security assessment that "restricted" scopes like Gmail require. Verification can run in parallel with the store review. Once approved: live data, no URL to paste, and the option to write reminders into the calendar instead of the template link. The connect button is opt-in and the event data never goes anywhere but the page.

**The pattern for everything else.** An integration is a URL or a token the user pastes, stored locally, sent only to its own origin, requested as an optional permission at save time. Cloud mode and grounding already work this way. Candidates that fit: RSS feeds as a reading panel, weather from Open-Meteo (no key needed), GitHub notifications with a personal token. Each is a declarative widget type with a config form, same as recipes.

**Status.** Step 1 shipped on 2026-09-21 as the Agenda widget. Step 2 starts the day the store listing is submitted, because the verification clock is the long one.

## Later, if asked

- **One shared model instance across tabs** through an offscreen document, so several open new tabs do not each hold 0.5 to 2.7 GB. The most likely cause of uninstalls once people keep several new tabs open; the highest-value engineering item left. **Spiked on branch `spike/offscreen-model` (2026-09-21): an offscreen document gets WebGPU (Apple, metal-3), SharedArrayBuffer, and cross-origin isolation, and loads and generates. What remains is the plumbing: a port-based provider in the page, load/ask/abort messages, progress and token events, and an idle unload.**
- `storage.sync` for todos and reminders across a Chrome profile. Recipes may exceed the 8 KB per-item quota, so they stay local unless chunked.
- Ollama auto-detect on localhost as a one-click cloud option.
- Firefox. It builds today, but extension pages lack SharedArrayBuffer there, so it would be single-threaded. Ship only if the WebGPU path makes that irrelevant.
- ~~Tab search from the ask bar.~~ Superseded by the Sessions widget, which takes the `tabs` permission as an optional grant when the widget is added.
- More widget types: Countdown, Clock, an RSS reading list, GitHub notifications with a personal token.

## Decided against

- **User-authored widgets as code.** Manifest V3 bars it; recipes and declarative widgets cover the real need.
- **Gmail.** Its scopes are "restricted", which means an annual third-party security assessment on top of verification, and reading mail is the opposite of the pitch. Calendar is different and is on the roadmap above.
- **Paid tiers or lifetime deals.** Zero marginal cost, no server, no accounts.
- **Analytics in the extension.** Contradicts the pitch and complicates the listing.
- **Arbitrary CSS themes and wallpapers.** Not a Chrome rule, a quality one: free CSS breaks contrast and dark mode and looks like user code to a reviewer; wallpapers pull the design toward a screensaver. Themes are parameters instead.
- **Scraping a search engine for grounding.** Breaks, violates terms, and gets store listings pulled. DuckDuckGo's Instant Answer API and Wikipedia's API are official, keyless, and CORS-open, so they are the free tier; DuckDuckGo's web results have no API and are not scraped. Full web results stay bring-your-own key.
- **The `history` permission.** Scares people at install and invites review trouble. Bookmarks are enough.
- **The `tabs` permission at install.** Chrome labels it "Read your browsing history". It exists only as an optional permission, asked for when someone adds the Sessions widget, with the reason stated in the widget.

## Sponsor slot rules

- The "Sponsor this slot" page goes live only after roughly 2,000 weekly active users in the store dashboard. Below that the price is not worth the negotiation.
- One line in the footer, labeled "Sponsored", a plain link with a `ref` parameter. No pixels, no scripts, no rotation by user data.
- Own products otherwise. Never an ad network.

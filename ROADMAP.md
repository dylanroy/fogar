# Fogar roadmap

Last updated 2026-09-21. Status of each item is in the checkbox. Dates are when a phase closed, not when it was planned.

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
- [x] Opt-in web grounding with a Brave Search or Tavily key. Citations and sources.
- [x] Recipes: data-only prompt forms with a builder, import, export, and share links. Four built-ins.
- [x] Todos. Reminders with a plain-language parser, confirmation, `chrome.alarms`, notifications, and a zero-permission Google Calendar link.
- [x] Bookmark search as you type, and a natural-language bookmark finder that has the model classify the list.
- [x] Landing page draft in `site/`.

## Now: release candidate, v0.1

The goal is a listing that gets approved on the first pass and a page that is true the day it goes live.

- [ ] Real-Chrome WebGPU numbers for Qwen3 0.6B and 1.7B in the README and on the landing page. Headless numbers are CPU only.
- [ ] Notifications on macOS: confirm Chrome has system notification permission in the first-run copy, since reminders are silent without it.
- [ ] Privacy policy page at `site/privacy.html`. It is short because there is nothing to disclose; the store requires it anyway.
- [ ] Store listing: single-purpose statement ("a private new tab assistant"), description, five 1280×800 screenshots, 440×280 promo tile.
- [ ] `wxt zip`, submit. New-tab overrides get extra review; expect days to weeks.
- [ ] Public GitHub repo. Point the landing page's "Get the source" button at it.
- [ ] Register fogar.ai and fogar.dev. Deploy `site/` (Cloudflare Pages or GitHub Pages; static either way).
- [ ] Recipe assistant: "Describe the recipe you want" and the model drafts the JSON, validated and opened in the existing editor. Cheap, and it makes the builder approachable for people who will not fill in a form from scratch.

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

## Later: declarative widgets

Recipes are one widget type: a prompt form. The same data-only approach extends to panels on the page.

- Widget types as a fixed set the extension knows how to render: Agenda, Links, Note, Countdown, Clock, Recipe shortcut. Users configure instances, arrange and hide panels, and share a panel's JSON the same way as a recipe.
- Todos and Reminders become the first two panels in the system, so the layout is user-controlled from the start.
- The builder is the same form approach as recipes. Still no user code.

**Gate.** People asking for layout control or a way to pin a recipe to the page.

## Later: integrations and the agenda widget

Dylan's ask: connect Google Calendar and show a daily agenda on the new tab. That is one of the best things a new tab can do, and it fits the filter as long as the connection is explicit and read-only. Two steps.

**Step 1, agenda from a calendar feed (no OAuth).** Every major calendar publishes a private iCal (ICS) URL: Google's "Secret address in iCal format", Outlook's "Publish calendar", iCloud's public sharing. The user pastes the URL, Fogar requests that one origin as an optional host permission, fetches and parses the feed, and renders today and tomorrow as a panel. Works for every provider on day one, needs no Google review, and the URL lives in extension storage like an API key. Feeds refresh on the provider's schedule, so events can lag by minutes to an hour, which is fine for an agenda and wrong for alarms.

**Step 2, Google Calendar OAuth, read-only.** `chrome.identity` with the `calendar.readonly` scope. That scope is "sensitive", which means Google's OAuth verification (privacy policy, homepage, a demo video, a scope justification; usually weeks) but not the annual third-party security assessment that "restricted" scopes like Gmail require. Verification can run in parallel with the store review. Once approved: live data, no URL to paste, and the option to write reminders into the calendar instead of the template link. The connect button is opt-in and the event data never goes anywhere but the page.

**The pattern for everything else.** An integration is a URL or a token the user pastes, stored locally, sent only to its own origin, requested as an optional permission at save time. Cloud mode and grounding already work this way. Candidates that fit: RSS feeds as a reading panel, weather from Open-Meteo (no key needed), GitHub notifications with a personal token. Each is a declarative widget type with a config form, same as recipes.

**Gate.** Agenda ships with declarative widgets, since it is a panel. Step 2 starts the day the store listing is submitted, because the verification clock is the long one.

## Later, if asked

## Decided against

- **User-authored widgets as code.** Manifest V3 bars it; recipes and declarative widgets cover the real need.
- **Gmail.** Its scopes are "restricted", which means an annual third-party security assessment on top of verification, and reading mail is the opposite of the pitch. Calendar is different and is on the roadmap above.
- **Paid tiers or lifetime deals.** Zero marginal cost, no server, no accounts.
- **Analytics in the extension.** Contradicts the pitch and complicates the listing.
- **Scraping a search engine for grounding.** Breaks, violates terms, and gets store listings pulled. Bring-your-own key or nothing.
- **The `history` permission.** Scares people at install and invites review trouble. Bookmarks are enough.

## Sponsor slot rules

- The "Sponsor this slot" page goes live only after roughly 2,000 weekly active users in the store dashboard. Below that the price is not worth the negotiation.
- One line in the footer, labeled "Sponsored", a plain link with a `ref` parameter. No pixels, no scripts, no rotation by user data.
- Own products otherwise. Never an ad network.

# Fogar Pro: sync across machines, and the widget catalog

Written 2026-09-23. A plan, not a spec: the shape of the first paid feature, what it changes about the product's
rules, the pieces to build in order, and the decisions only Dylan can make. Everything here is meant to be
checked against the filter in `ROADMAP.md`; where it bends a rule, it says so.

## 1. What is being decided

Fogar has no server, no accounts, and a roadmap rule that says "Free. No tiers." Sync across machines cannot
exist without a server and an account, and Dylan wants it to be the first Pro feature. So three things change at
once, and the plan is honest about each:

1. **A Pro tier exists.** One paid plan, for features that cannot run without a server. Everything that runs
   locally today stays free. No trials, no lifetime deals, no ads beyond the footer line.
2. **An account exists, but only for Pro.** A free install never creates one and never talks to fogar.ai from
   the extension, with one small, switchable exception described in section 5.
3. **Some widgets can be marked Pro from an admin page**, without a store release. This is a product lever, not a
   technical necessity: every widget in this change runs locally and would work fine for free. Locking one is a
   pricing decision made in the admin page, and the extension respects it.

Proposed rewrite of principle 4 in `ROADMAP.md`:

> **Free for everything that runs on your machine.** Pro is one paid tier for features that need a server, sync
> first. No trials, no lifetime deals, no accounts unless you buy Pro, no analytics either way. The footer line
> stays; a labeled sponsor line may appear later.

## 2. What Pro is, in one paragraph

An email address, a subscription through Stripe, and a passphrase that only the user knows. Signing in on a
second machine and typing the passphrase brings over the layout, the theme, the widgets and their contents, the
recipes, the todos, the reminders, the saved sessions, the notebook pages, the post-its, the chat model profiles,
and the settings. Fogar's server sees only encrypted blobs and the email address. The models, which are
gigabytes, are downloaded again on each machine as they are today.

## 3. Sync

### 3.1 What syncs

Every `fogar.*` key in `chrome.storage.local` except caches, plus the widget data keys. Concretely, the same set
`lib/backup.ts` exports today, extended with the new widgets' `fogar.widget.<id>` documents, `fogar.chat.models`,
and `fogar.email.auth.*` tokens. Never synced: model weights (OPFS), the network ledger, attachments, session
storage, per-widget fetch caches (mail, feeds, Jira, weather, agenda), and the Pro session token itself.

Whether API keys and tokens sync is a switch, default **on**, labeled "Sync keys and tokens too (encrypted; only
you can read them)". The value of sync on a second machine is largely the cloud endpoint and the Jira and Gmail
connections being there already; with end-to-end encryption the server cannot read them. Off leaves those fields
blank on the other machine.

### 3.2 Encryption: the server holds blobs it cannot open

- On sign-in, the user chooses a passphrase. `PBKDF2-SHA-256` with 600,000 iterations (WebCrypto, no
  dependencies) derives a 256-bit key; the salt is random per account and stored on the server in the clear.
  Argon2id would be stronger but needs WebAssembly; PBKDF2 at this iteration count is the OWASP baseline and is
  fine for a passphrase Fogar insists is at least four words.
- Each document is encrypted with `AES-256-GCM`, a fresh 96-bit nonce per write; the key name is stored in the
  clear so the server can address documents, the content is not.
- The key never leaves the device. There is no recovery: the sign-in screen says so, offers a printable recovery
  phrase (the passphrase, formatted), and points out that the local copy on each machine is intact regardless.
- Changing the passphrase re-encrypts every document from a signed-in device and bumps an `epoch` on the
  account; other devices ask for the new passphrase on their next sync.

### 3.3 Data model and merging

Each storage key is a document: `{ key, version, updatedAt, deviceId, epoch, nonce, blob }`. `version` is a
per-account counter assigned by the server on write (a simple total order, no clocks to trust). The client
remembers the highest version it has seen.

Merging is per key, and reuses what already exists:

| Key | Rule |
|---|---|
| `fogar.settings`, `fogar.theme`, `fogar.layout`, `fogar.catalog`-style singletons | Last writer wins, by `updatedAt` with `version` as the tiebreak. The layout is one document, so a widget added on machine A and one added on machine B within the same sync window means one of them loses; the loser's widget data key still syncs, and the next sync shows "1 widget from your other machine is not on this page: add it" from a reconcile pass that compares `fogar.widget.*` keys against the layout. |
| `fogar.todos`, `fogar.reminders`, `fogar.recipes`, `fogar.sessions`, `fogar.chat.models` | Set union by id, exactly what `importBackup` does today, plus **tombstones**: a deletion writes `{ id, deletedAt }` into a per-key tombstone list kept for 30 days, so a todo removed on one machine does not come back from the other. |
| `fogar.widget.<id>` (notes, notebook pages, post-its, canvas shapes, chat conversations) | Last writer wins per document. Post-its and notebook pages are arrays inside one document; a per-item merge is a later refinement if people hit it. |

The client-side merge runs inside the existing backup import code path, so the unit that is tested is "two
backups merged", which is already the mental model of the code.

### 3.4 Transport and server

Cloudflare, because fogar.ai is already there and the free tier covers the first thousand users.

- **Worker `fogar-api`** at `api.fogar.ai` (a second Worker beside `fogar-site`), routes:
  `POST /auth/start` (email → magic link), `GET /auth/finish` (link → session token), `GET /me` (account,
  subscription state, devices, salt, epoch), `POST /sync` (push documents; returns new versions),
  `GET /sync?since=N` (pull), `DELETE /devices/:id`, `POST /billing/checkout`, `POST /billing/portal`,
  `POST /webhooks/stripe`.
- **D1** tables: `accounts`, `sessions`, `devices`, `subscriptions`, `documents (account_id, key, version, epoch,
  nonce, blob, updated_at)` with an index on `(account_id, version)`. Blobs are small (the whole of Fogar's
  storage is usually under a megabyte); if canvases and notebooks grow, blobs over 100 KB move to R2 with a
  pointer in D1.
- **Magic links** sent with Resend (or Cloudflare Email Service once available on the account); no passwords
  to store. Sessions are 90-day tokens, revocable from the devices list.
- **Stripe** Checkout for the subscription and the Customer Portal for changes; the webhook flips
  `subscriptions.status`. The extension never sees card data.
- **Rate limits** per account on `/sync` (60/min) and a 5 MB total storage cap per account to keep the free
  tier free.

### 3.5 The client

- A `lib/sync.ts` module: sign-in flow, key derivation, encrypt/decrypt, push/pull, merge. The extension
  requests `https://api.fogar.ai/*` as an **optional host permission at sign-in**, the same way it does for a
  cloud endpoint, so the manifest does not change and free installs never hold the permission (principle 3).
- **When it syncs.** On a change: the background worker watches `storage.onChanged`, debounces three seconds,
  and pushes. On a schedule: a `chrome.alarms` entry every five minutes pulls if signed in. On open: a new tab
  pulls once if the last pull is older than a minute. Realtime through a Durable Object WebSocket is a later
  refinement; five minutes is fine for a new tab page.
- **Offline.** Pushes queue in storage and drain when the network is back; the entitlement (`fogar.pro`) is
  cached with a seven-day grace so a flight does not lock anything.
- **Settings UI.** A "Fogar Pro" fieldset: sign in / manage subscription / devices / passphrase / the keys
  switch / "last synced 2 min ago from MacBook" / a sync-now button. The network ledger shows `api.fogar.ai`
  like any other host.
- **Privacy policy** gains a row: "Pro sync (only if you subscribe): your Fogar data, encrypted on your device
  with a passphrase we never see, plus your email address; to api.fogar.ai."

### 3.6 Failure modes worth designing for now

- Two machines editing the same notebook page offline: last writer wins and the other machine's version is kept
  for seven days under "Recently replaced" in Settings, downloadable. Cheap insurance against the worst feeling
  sync can produce.
- A forgotten passphrase: the account still works for billing; sync data is unreadable; "Start sync fresh from
  this machine" wipes the server copy and re-uploads. Stated plainly on the sign-in screen.
- A subscription lapses: sync stops, nothing is deleted for 90 days, everything local stays; Pro widgets on the
  page keep working read-only (section 5.3).

## 4. Order of work

Each step ships behind the next gate; nothing here needs to land in one release.

| Step | Builds | Gate to the next |
|---|---|---|
| **0. Scaffold (in this change)** | `lib/catalog.ts` with a tier per widget (all free), a Pro tag and lock in the Add menu that is dormant until a tier flips, `fogar.pro` as the entitlement key. | Widgets shipped and the store listing approved. |
| **1. Account and billing** | `fogar-api` Worker, D1 schema, magic-link sign-in, Stripe Checkout and Portal, webhooks, `/me`. Settings fieldset with sign-in and subscription state. No sync yet: Pro unlocks nothing but the badge. | Dylan can buy Pro on a test card end to end; the smoke suite runs the sign-in flow against a mock API on 127.0.0.1. |
| **2. Sync** | `lib/sync.ts`: passphrase, PBKDF2, AES-GCM, document push/pull, merge with tombstones, background alarm, devices list, "Recently replaced". | Two Chromium profiles in the smoke suite converge on the same layout, todos, and a notebook page through the mock API, with a deletion on one side winning on the other. |
| **3. Admin page and remote catalog** | `fogar.ai/admin` behind Cloudflare Access; a Free/Pro toggle per widget writing `catalog.json` to KV; the extension's daily catalog check with its Settings switch (section 5). | A toggle in admin changes the Add menu on a test install within a day without a release. |
| **4. Launch** | Privacy policy and listing updates, a `/pro` page on fogar.ai, the roadmap principle rewritten, blog post. | |

Rough sizes, for one person: step 1 about a week, step 2 two to three weeks including the merge tests, step 3
three or four days, step 4 two days.

## 5. The admin page and the widget catalog

### 5.1 The page

`https://fogar.ai/admin`, served by the existing `fogar-site` Worker with a fetch handler added for `/admin` and
`/api/admin/*`, and protected by **Cloudflare Access** (Zero Trust, free up to 50 users) with Dylan's Google
account as the only allowed identity. Access handles login; the Worker only checks the `Cf-Access-Jwt-Assertion`
header. No auth code to write, no password to leak.

The page is one table: every widget type from `lib/catalog.ts`, its current tier, a Free/Pro toggle, and a
"Publish" button. Publishing writes `{ version, updatedAt, tiers }` to a KV key that `GET /catalog.json` serves
with `Cache-Control: max-age=3600`. A second tab shows Pro accounts (count, active subscriptions, storage per
account, devices), a per-account "revoke all devices" for support, and two flags: "sync enabled" (kill switch)
and a maintenance message.

### 5.2 How the extension learns about a toggle

This is the one place the plan bends principle 1, so the options are spelled out:

- **A. Baked in.** `lib/catalog.ts` is the only catalog; admin edits the file through the GitHub API and the
  toggle ships with the next store release (days to weeks). Principle 1 untouched; the admin page is a nicer
  editor for a JSON file.
- **B. Daily check, switchable.** The background worker fetches `https://fogar.ai/catalog.json` once a day with
  no identifiers, `cache: 'no-store'`, and writes the tiers to `fogar.catalog`. A Settings switch, "Check
  fogar.ai once a day for Pro and widget updates", is on by default and disclosed in the privacy policy and the
  ledger; off means the baked-in catalog applies. One anonymous GET a day to Fogar's own site.
- **C. Only when signed in.** The catalog rides along in `/me` for Pro users; free installs use the baked-in
  copy. Toggles reach the people who are already paying and nobody else, which defeats the purpose of marking a
  widget Pro.

**Recommendation: B**, with the switch. The request carries nothing, is visible in the ledger, and can be turned
off; a store release per pricing change (A) is too slow to be a lever, and C does not reach free users. The
privacy policy sentence writes itself: "Once a day the extension fetches fogar.ai/catalog.json, a public file that
says which widgets are part of Pro. It sends no identifiers. Turn it off in Settings."

### 5.3 What a lock means on the page

- In the Add menu a Pro widget carries a **Pro** tag; clicking it explains and offers sign-in. The badge and
  lock are already wired in `entrypoints/newtab/widgets/index.ts` and become visible the day a tier flips.
- A Pro widget already on the page when a toggle flips, or when a subscription lapses, keeps rendering but
  goes **read-only** after the seven-day grace: its data is never deleted and stays in backups. Locking people
  out of their own notes is the fastest way to a one-star review.
- Locks are client-side in an MIT-licensed extension, so they are a request, not a wall. That is fine; it is
  the same deal every indie app makes.

## 6. Decisions for Dylan

1. **Price.** A suggestion to react to: $4 a month or $36 a year, one plan. Sync is the feature; Pro widgets are
   the reason to look at the plan page.
2. **Keys and tokens in sync:** default on (recommended, encrypted) or off.
3. **Catalog check:** option B with the switch (recommended), or A.
4. **Sign-in method:** magic link (recommended, nothing to store) or passkeys later.
5. **Gmail.** The Inbox widget shipped in this change uses the unread feed of the signed-in account, or the
   user's own OAuth client id. Fogar itself never holds a restricted Google scope, so the roadmap's "Decided
   against: Gmail" becomes "Decided against: a Fogar-owned Gmail OAuth client". Confirm that reading.
6. **Which widgets go Pro on day one**, if any. The plan works with zero.

## 7. Tests, per step

- Step 1: the smoke suite drives sign-in against a mock `api.fogar.ai` on 127.0.0.1 (magic link returned in the
  response for tests), sees `fogar.pro` set, and sees the Pro fieldset change state; a webhook payload flips
  the state back.
- Step 2: two persistent Chromium profiles share one mock API; a layout change, a todo, a todo deletion, a
  notebook page, and a post-it board converge; a passphrase mismatch is refused; an offline push drains on
  reconnect (mock returns 503 then 200).
- Step 3: the mock serves `catalog.json` marking `canvas` Pro; the Add menu shows the tag and the toast; the
  switch off restores the baked-in catalog; a Pro widget on the page renders read-only after the grace.

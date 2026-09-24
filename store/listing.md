# Chrome Web Store listing

## Name
Fogar

## Summary (132 characters max)
A private new tab that answers from a model running in your browser. Recipes, reminders, agenda, bookmarks. Nothing leaves the room.

## Category
Productivity → Workflow & Planning

## Single purpose statement
Fogar replaces the new tab page with a private assistant: an ask box answered by a language model running inside the browser (or a cloud model the user connects with their own key), plus panels the user chooses (todos, reminders, agenda, saved browser sessions, links, notes, weather, pinned prompt recipes, a writing panel that rewrites and drafts in the user's own voice, a Gmail inbox and Jira issues read with the user's own credentials, RSS feeds, a chat with a model of the user's choice, a whiteboard, a notebook that reads photos into text, and sticky notes).

## Description

**Ask your new tab. Nothing leaves the room.**

Fogar answers questions from a language model that runs inside your browser. No account, no API key, no server. Once the model is downloaded (once, 533 MB to 2.7 GB depending on the size you pick), your questions never leave your machine. Turn off Wi-Fi and it keeps working.

When you want a bigger brain, switch to Cloud and bring your own key for OpenAI, OpenRouter, Groq, Ollama on localhost, or anything OpenAI-compatible. Your key stays in this browser and is sent only to the address you typed.

**What it does**
• Ask anything, with follow-ups. Answers stream in, rendered cleanly.
• Recipes: prompt forms for the things you actually do. Draft & rewrite, Reply to a message, Summarize, Explain simply. Make your own and share them as a link.
• Writing: paste a few things you actually wrote, distill them once into a voice profile you can read and edit, and rewrite, tighten, warm up, or draft in your own voice. Registers keep email, chat, and essays apart; add your own, with rules followed to the letter. Runs on the device model or any model you connected.
• Reminders in plain words: "call the dentist tomorrow at 9". Fires as a Chrome notification. One click adds it to Google Calendar, no account connection needed.
• Agenda from any calendar's iCal address. Today and tomorrow, on every new tab.
• Todos, Links, Notes, Weather (from Open-Meteo, no key). Pin the panels you want, in the order you want, or hit Focus for just the ask box.
• Sessions: twenty windows, three hundred tabs, zero fear. Save a window and close it; every tab stays one search away. Restore a window later, promote tabs into a bookmark folder, or export everything as a Markdown list or a bookmarks file any browser can import. Asks for the tabs permission only when you add the widget.
• Bookmarks: start typing to find one. Or ask "find bookmarks that are job postings" and the model sorts them for you.
• Inbox: your latest Gmail on the new tab, from Gmail's own unread feed for the account you are signed into (a label is the filter), or through the Gmail API with an OAuth client you create in your own Google project (any search). Read-only; nothing passes through a Fogar server.
• Feed: RSS and Atom feeds, or just a site's address, plus searches on Google News, Hacker News, Reddit, and Bing News, merged newest first with a dot on what is new.
• Jira: the issues from any JQL query, with your own API token. Read-only.
• LLM Chat: talk to the model on this device, your cloud endpoint, or models you add: Claude, GPT, Gemini, OpenRouter, Groq, Ollama, LM Studio. Keys stay in this browser. Conversations are kept.
• Canvas: a whiteboard with pen, highlighter, arrows, boxes, and text. Or say "draw a house" and the model draws it. Save as PNG.
• Notebook: ruled pages. Photograph a page and it becomes text, read on this device (printed text, no upload) or by a vision model you connected (handwriting).
• Post-its: sticky notes you drag around, stack, and pull off into their own widget.
• Any widget goes full screen with one click; Escape brings the page back.
• Right-click any text on any page: "Ask Fogar about …". The page's title, address, and the text around your selection go along, so the answer comes from the page you were reading.
• Drop a PDF, Word file, or text file on the box and ask about it. It is read in your browser and never uploaded; the chip on the box says how much of it the model got, and it stays for your follow-up questions.
• Make it yours: light or dark, accent colors, paper tint, fonts, density, a centered ask box or a widget sidebar on wide screens. Drag widgets into order. Share a theme as a link.
• Dig deeper on any answer: search the web and answer again with sources, let the model think longer, or ask your cloud model the same question.
• Arithmetic is computed, not guessed: "18% of 240" gives 43.2 every time.
• Optional web grounding: tick “Search the web first” and Fogar looks the question up on DuckDuckGo instant answers and Wikipedia, no key needed, then answers with sources. Add a Brave Search or Tavily key for full web results.

**Honest about the model**
Small models are good writers and poor encyclopedias. Fogar picks the largest model your machine can run well (it measured 44 tokens per second for the 2.7 GB model on an Apple laptop with WebGPU), leads with writing tasks, and offers grounding for facts.

**Privacy you can verify**
A live network ledger in Settings counts every request this tab has made, by host, from the browser's own timeline. In local mode it says zero. There is no analytics and no telemetry. Privacy policy: https://fogar.ai/privacy

Free. Open source. Made by Dylan Roy.

## Permission justifications (for the review form)
- **storage**: settings, todos, reminders, recipes, notes, widget layout, on device.
- **alarms**: reminders fire at the time the user set.
- **notifications**: a reminder is shown as a Chrome notification.
- **bookmarks**: bookmark search as the user types, and removal on request.
- **contextMenus**: the "Ask Fogar about …" right-click item.
- **favicon**: site icons next to bookmarks and links.
- **unlimitedStorage**: saved sessions can outgrow the default quota; no install warning.
- **tabs (optional)**: requested only when the user adds the Sessions widget, to list, search and save the titles and addresses of open tabs on the device.
- **identity (optional)**: requested only when the user connects Gmail through their own OAuth client in the Inbox widget, to open Google's sign-in window (`identity.launchWebAuthFlow`). Fogar ships no OAuth client of its own.
- **activeTab, scripting**: on a right-click "Ask Fogar about …", read the title, address, and text around the selection from that one page, that one time. Nothing runs on pages otherwise.
- **host permission huggingface.co**: downloading the model file once.
- **optional host permissions (https://*/*, localhost)**: requested individually when the user saves a cloud endpoint, search API key, calendar address, feed address, Jira site, chat model endpoint, or connects Gmail, so Fogar can reach exactly that address.
- **chrome_url_overrides.newtab**: the product is a new tab page.

## Data usage disclosures
- Does not collect or transmit user data. No analytics, no telemetry.
- Data the user enters is stored locally. When the user configures a cloud endpoint, search provider, calendar feed, weather city, feed address, Jira site, or chat model, requests go only to that address. Ticking “Search the web first” sends the question to DuckDuckGo and Wikipedia (or the search provider the user chose).
- Inbox widget: Gmail's unread feed is fetched from mail.google.com with the browser's own session, or the Gmail API is called with a token the user obtained through their own OAuth client. Mail headers and snippets are cached in extension storage for a few minutes and never sent anywhere else.
- Notebook widget: a photo is downscaled in the page and read on the device, or, when the user picks a vision model they connected, sent once to that endpoint. Photos are never stored.
- Writing widget: the user's writing samples go to the model the user picked, once, when they press Distill; the resulting profile, the register's rules, and the text being rewritten go to that model on each run. On device nothing is sent. Samples, profile, and registers are stored in extension storage.
- Canvas widget: when the user asks the model to draw, the drawing's shapes and the instruction go to the model the user chose (on device or their own endpoint).
- Files the user attaches to a question are read inside the page and held in memory for that tab only; they are never stored. In local mode nothing is sent. In cloud mode the text that fits the prompt goes to the user's endpoint together with the question.
- Not sold, not used for ads, not used for creditworthiness or lending, not transferred to third parties.

## Assets (generated by `PROFILE=/tmp/fogar-eval-profile node scripts/store-assets.mjs`)
JPEG, because the store wants JPEG or 24-bit PNG without alpha.
- store/screenshots/01-answer.jpg: real answer plus follow-up, Dig deeper menu open
- store/screenshots/02-widgets.jpg: agenda, weather, todos, reminders, links, notes
- store/screenshots/03-recipe.jpg: Draft & rewrite with its output
- store/screenshots/04-customize.jpg: Customize open on the Moss dark theme
- store/screenshots/05-settings.jpg: model tiers, grounding, network ledger
- store/promo-440x280.jpg (small promo tile), store/marquee-1400x560.jpg

## Support and links
- Homepage: https://fogar.ai
- Privacy policy: https://fogar.ai/privacy
- Support: https://github.com/dylanroy/fogar/issues (or https://dylanroy.com)

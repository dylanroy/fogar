# Chrome Web Store listing

## Name
Fogar

## Summary (132 characters max)
A private new tab that answers from a model running in your browser. Recipes, reminders, agenda, bookmarks. Nothing leaves the room.

## Category
Productivity → Workflow & Planning

## Single purpose statement
Fogar replaces the new tab page with a private assistant: an ask box answered by a language model running inside the browser (or a cloud model the user connects with their own key), plus panels the user chooses (todos, reminders, agenda, links, notes, weather, pinned prompt recipes).

## Description

**Ask your new tab. Nothing leaves the room.**

Fogar answers questions from a language model that runs inside your browser. No account, no API key, no server. Once the model is downloaded (once, 533 MB to 2.7 GB depending on the size you pick), your questions never leave your machine. Turn off Wi-Fi and it keeps working.

When you want a bigger brain, switch to Cloud and bring your own key for OpenAI, OpenRouter, Groq, Ollama on localhost, or anything OpenAI-compatible. Your key stays in this browser and is sent only to the address you typed.

**What it does**
• Ask anything, with follow-ups. Answers stream in, rendered cleanly.
• Recipes: prompt forms for the things you actually do. Draft & rewrite, Reply to a message, Summarize, Explain simply. Make your own and share them as a link.
• Reminders in plain words: "call the dentist tomorrow at 9". Fires as a Chrome notification. One click adds it to Google Calendar, no account connection needed.
• Agenda from any calendar's iCal address. Today and tomorrow, on every new tab.
• Todos, Links, Notes, Weather (from Open-Meteo, no key). Pin the panels you want, in the order you want, or hit Focus for just the ask box.
• Sessions: twenty windows, three hundred tabs, zero fear. Save a window and close it; every tab stays one search away. Restore a window later, promote tabs into a bookmark folder, or export everything as a Markdown list or a bookmarks file any browser can import. Asks for the tabs permission only when you add the widget.
• Bookmarks: start typing to find one. Or ask "find bookmarks that are job postings" and the model sorts them for you.
• Right-click any text on any page: "Ask Fogar about …". The page's title, address, and the text around your selection go along, so the answer comes from the page you were reading.
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
- **tabs (optional)**: requested only when the user adds the Sessions widget, to list and save the titles and addresses of open tabs on the device.
- **activeTab, scripting**: on a right-click "Ask Fogar about …", read the title, address, and text around the selection from that one page, that one time. Nothing runs on pages otherwise.
- **host permission huggingface.co**: downloading the model file once.
- **optional host permissions (https://*/*, localhost)**: requested individually when the user saves a cloud endpoint, search API key, or calendar address, so Fogar can reach exactly that address.
- **chrome_url_overrides.newtab**: the product is a new tab page.

## Data usage disclosures
- Does not collect or transmit user data. No analytics, no telemetry.
- Data the user enters is stored locally. When the user configures a cloud endpoint, search provider, calendar feed, or weather city, requests go only to that address. Ticking “Search the web first” sends the question to DuckDuckGo and Wikipedia (or the search provider the user chose).
- Not sold, not used for ads, not used for creditworthiness or lending, not transferred to third parties.

## Assets (generated by `node scripts/store-assets.mjs`)
- store/screenshots/01-answer.png … 05-firstrun.png (1280×800)
- store/promo-440x280.png (small promo tile)
- store/marquee-1400x560.png

## Support and links
- Homepage: https://fogar.ai
- Privacy policy: https://fogar.ai/privacy
- Support: https://github.com/dylanroy/fogar/issues (or https://dylanroy.com)

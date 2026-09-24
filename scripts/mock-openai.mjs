// Local stand-ins for the network the extension talks to in cloud and grounded modes, and for the widgets.
//   POST /v1/chat/completions       OpenAI-compatible SSE stream; records the last request. Non-streamed calls
//                                   (the Notebook's photo reading) get a JSON reply; a "You edit a drawing" system
//                                   prompt gets a shapes JSON for the Canvas; the Writing widget's distill and
//                                   run prompts get a voice profile and a line with an em dash to strip.
//   GET  /v1/models                 two model ids, for the chat widget's "Fetch models".
//   POST /anthropic/v1/messages     Anthropic Messages API, streamed or not; records headers and body.
//   GET  /brave?q=                  Brave Search API shape with two fixed results.
//   GET  /gmail/u/N/feed/atom[/l]   Gmail's unread feed, three entries; GET /gmail/v1/users/me/messages[/id] the API.
//   GET  /rss /atom /site /query    feeds for the Feed widget; /site is a page that advertises /atom.
//   GET  /rest/api/3/search/jql     two Jira issues; records auth and jql.
// All send CORS headers so the extension page can call them without a host permission, as real APIs do.
import { createServer } from 'node:http';

export function startMockServer(port = 0) {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, accept, x-subscription-token, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/invoice.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>Quarterly Invoice from Globex</title></head><body><h1>Invoice 2026-Q3</h1><p>Total due: 4,200.</p></body></html>');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Acme Careers: Senior Engineer</title></head><body>
<h1>Senior Engineer, Platform</h1>
<p>Acme builds tooling for small teams. This role reports to Priya Natarajan, who runs the platform group.</p>
<p>You may know Priya as "The Micro Startups Guy" from the newsletter of the same name, which she has written since 2021 and which covers one-person software companies.</p>
<p>The role is remote in US time zones. Interviews are two rounds. Salary range is posted below.</p>
</body></html>`);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/agenda.ics') {
      const pad = (n) => String(n).padStart(2, '0');
      const local = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
      const today = new Date(); today.setHours(14, 0, 0, 0);
      const todayEnd = new Date(today.getTime() + 3600e3);
      const tomorrow = new Date(today.getTime() + 86400e3);
      const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      const weekAgo = new Date(today.getTime() - 7 * 86400e3); weekAgo.setHours(9, 30, 0, 0);
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      res.end(['BEGIN:VCALENDAR', 'VERSION:2.0',
        'BEGIN:VEVENT', 'UID:one', `DTSTART:${local(today)}`, `DTEND:${local(todayEnd)}`, 'SUMMARY:Design review', 'LOCATION:Room 4', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:standup', `DTSTART:${local(weekAgo)}`, 'DURATION:PT15M', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', 'SUMMARY:Standup', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:dentist', `DTSTART;VALUE=DATE:${ymd(tomorrow)}`, 'SUMMARY:Dentist', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:gone', `DTSTART:${local(today)}`, `DTEND:${local(todayEnd)}`, 'SUMMARY:Cancelled thing', 'STATUS:CANCELLED', 'END:VEVENT',
        'END:VCALENDAR'].join('\r\n'));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/weather') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const day = (i) => new Date(Date.now() + i * 86400e3).toISOString().slice(0, 10);
      res.end(JSON.stringify({ current: { temperature_2m: 71.4, weather_code: 2, wind_speed_10m: 6.2 }, daily: { time: [day(0), day(1), day(2), day(3)], temperature_2m_max: [78, 80, 66, 70], temperature_2m_min: [55, 57, 48, 50], weather_code: [2, 0, 61, 3] } }));
      return;
    }

    // ---- widgets: Gmail feed and API ----
    const gmailFeed = url.pathname.match(/^\/gmail\/u\/(\d+)\/feed\/atom(?:\/(.+))?$/);
    if (req.method === 'GET' && gmailFeed) {
      server.lastGmail = { account: Number(gmailFeed[1]), label: gmailFeed[2] ? decodeURIComponent(gmailFeed[2]) : '' };
      const iso = (ms) => new Date(Date.now() - ms).toISOString();
      const entry = (id, title, summary, name, mail, ago) => `<entry><title>${title}</title><summary>${summary}</summary><link rel="alternate" href="https://mail.google.com/mail?account_id=test@example.com&amp;message_id=${id}&amp;view=conv&amp;extsrc=atom" type="text/html"/><modified>${iso(ago)}</modified><issued>${iso(ago)}</issued><id>tag:gmail.google.com,2004:${id}</id><author><name>${name}</name><email>${mail}</email></author></entry>`;
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=UTF-8' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><feed version="0.3" xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox for test@example.com</title><tagline>New messages in your Gmail Inbox</tagline><fullcount>3</fullcount><link rel="alternate" href="https://mail.google.com/mail" type="text/html"/><modified>${iso(0)}</modified>${entry('18f0a1b2c3d4e5f6', 'Quarterly invoice', 'Total due 4,200 by Friday.', 'Globex Billing', 'billing@globex.example', 3600e3)}${entry('18f0a1b2c3d4e5f7', 'Interview slots', 'Tuesday or Thursday afternoon works.', 'Priya Natarajan', 'priya@acme.example', 7200e3)}${entry('18f0a1b2c3d4e5f8', 'Your order shipped', 'Arrives Monday.', 'Shop', 'orders@shop.example', 86400e3)}</feed>`);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/gmail/v1/users/me/messages') {
      server.lastGmailApi = { q: url.searchParams.get('q'), max: url.searchParams.get('maxResults'), auth: req.headers.authorization };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: 'a1', threadId: 't1' }, { id: 'a2', threadId: 't2' }], resultSizeEstimate: 2 }));
      return;
    }
    const gmailMsg = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/(\w+)$/);
    if (req.method === 'GET' && gmailMsg) {
      const id = gmailMsg[1];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, threadId: id === 'a1' ? 't1' : 't2', snippet: id === 'a1' ? 'Your Stripe payout of $1,250.00 &amp; a receipt' : 'Weekly summary', labelIds: id === 'a1' ? ['UNREAD', 'INBOX'] : ['INBOX'], internalDate: String(Date.now() - (id === 'a1' ? 1800e3 : 5 * 3600e3)), payload: { headers: [{ name: 'From', value: id === 'a1' ? 'Stripe <notifications@stripe.com>' : 'Acme Digest <digest@acme.example>' }, { name: 'Subject', value: id === 'a1' ? 'Payout sent' : 'This week at Acme' }, { name: 'Date', value: new Date().toUTCString() }] } }));
      return;
    }
    // ---- widgets: feeds ----
    const rfc = (ms) => new Date(Date.now() - ms).toUTCString();
    if (req.method === 'GET' && url.pathname === '/rss') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(`<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Mock RSS</title><link>https://example.com/</link><item><title>Alpha post</title><link>https://example.com/alpha</link><guid>alpha</guid><pubDate>${rfc(3600e3)}</pubDate><description>&lt;p&gt;Alpha is &lt;b&gt;first&lt;/b&gt;.&lt;/p&gt;</description><dc:creator>Ada</dc:creator></item><item><title>Beta post</title><link>https://example.com/beta</link><pubDate>${rfc(3 * 3600e3)}</pubDate><description>Beta body</description></item><item><title>Shared post</title><link>https://example.com/shared</link><pubDate>${rfc(5 * 3600e3)}</pubDate></item></channel></rss>`);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/atom') {
      res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
      res.end(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Mock Atom</title><entry><title>Gamma entry</title><link rel="alternate" href="https://example.org/gamma"/><id>gamma</id><updated>${new Date(Date.now() - 1800e3).toISOString()}</updated><summary>Gamma summary</summary><author><name>Grace</name></author></entry><entry><title>Shared post (atom copy)</title><link href="https://example.com/shared/"/><id>shared2</id><updated>${new Date(Date.now() - 4 * 3600e3).toISOString()}</updated></entry></feed>`);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/site') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Mock Site</title><link rel="alternate" type="application/atom+xml" href="/atom"></head><body><h1>A site with a feed</h1></body></html>');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/query') {
      server.lastQuery = { provider: url.searchParams.get('provider'), q: url.searchParams.get('q') };
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Search: ${url.searchParams.get('q')}</title><item><title>Result for ${url.searchParams.get('q')}</title><link>https://news.example/result</link><pubDate>${rfc(2 * 3600e3)}</pubDate></item></channel></rss>`);
      return;
    }
    // ---- widgets: Jira ----
    if (req.method === 'GET' && (url.pathname === '/rest/api/3/search/jql' || url.pathname === '/rest/api/2/search')) {
      server.lastJira = { path: url.pathname, jql: url.searchParams.get('jql'), max: url.searchParams.get('maxResults'), auth: req.headers.authorization };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ issues: [
        { key: 'FOG-12', fields: { summary: 'Ship the widgets', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, priority: { name: 'High' }, issuetype: { name: 'Task' }, assignee: { displayName: 'Dylan Roy' }, updated: new Date(Date.now() - 600e3).toISOString() } },
        { key: 'FOG-9', fields: { summary: 'Write the plan', status: { name: 'To Do', statusCategory: { key: 'new' } }, priority: { name: 'Medium' }, issuetype: { name: 'Story' }, updated: new Date(Date.now() - 86400e3).toISOString() } },
      ], isLast: true }));
      return;
    }
    // ---- widgets: model lists and the Anthropic Messages API ----
    if (req.method === 'GET' && url.pathname === '/anthropic/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }] }));
      return;
    }
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      server.lastModels = { auth: req.headers.authorization };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-mini' }] }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/anthropic/v1/messages') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        server.lastAnthropic = { key: req.headers['x-api-key'], version: req.headers['anthropic-version'], browser: req.headers['anthropic-dangerous-direct-browser-access'], body: parsed };
        const hasImage = parsed.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image' && c.source?.type === 'base64'));
        if (!parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: parsed.model, stop_reason: 'end_turn', content: [{ type: 'text', text: hasImage ? 'MOCK VISION TEXT\nfrom Claude' : 'Claude mock reply' }] }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        ev('message_start', { message: { id: 'msg_mock', role: 'assistant', model: parsed.model, content: [] } });
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        const words = ['Claude', ' mock', ' reply'];
        let i = 0;
        const tick = setInterval(() => {
          if (i < words.length) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: words[i++] } });
          else { clearInterval(tick); ev('content_block_stop', { index: 0 }); ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }); ev('message_stop', {}); res.end(); }
        }, 15);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/ddg') {
      server.lastFree = { ...(server.lastFree ?? {}), ddgQ: url.searchParams.get('q') };
      res.writeHead(202, { 'Content-Type': 'application/x-javascript' }); // DuckDuckGo really answers 202
      res.end(JSON.stringify({ Heading: 'Mock Person', AbstractText: 'MOCK DDG ABSTRACT about the person, the head of state.', AbstractURL: 'https://en.wikipedia.org/wiki/Mock_Person', AbstractSource: 'Wikipedia',
        RelatedTopics: [{ Text: 'Mock Topic - a related thing', FirstURL: 'https://duckduckgo.com/Mock_Topic' }, { FirstURL: 'https://duckduckgo.com/c/Mock_Category', Text: 'Mock Person Category' }, { Name: 'Group', Topics: [{ Text: 'Nested Topic - inside a group', FirstURL: 'https://duckduckgo.com/Nested' }] }] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/wiki') {
      server.lastFree = { ...(server.lastFree ?? {}), wikiQ: url.searchParams.get('gsrsearch') };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // The query is "the US president". Page 2 shares the DDG abstract's URL with a shorter text, so the merge must
      // keep the abstract and drop it. Page 3 matched on body text alone and must not reach the model; page 4 is a
      // disambiguation stub.
      res.end(JSON.stringify({ query: { pages: {
        '2': { pageid: 2, index: 2, title: 'Mock Person', extract: 'MOCK WIKI SECOND about the president.', fullurl: 'https://en.wikipedia.org/wiki/Mock_Person' },
        '1': { pageid: 1, index: 1, title: 'President of Mockland', extract: 'MOCK WIKI EXTRACT about the president from the encyclopedia.', fullurl: 'https://en.wikipedia.org/wiki/President_of_Mockland' },
        '3': { pageid: 3, index: 3, title: 'Tupac Shakur', extract: 'MOCK WIKI NOISE: an American rapper whose long article happens to use the same everyday words.', fullurl: 'https://en.wikipedia.org/wiki/Tupac_Shakur' },
        '4': { pageid: 4, index: 4, title: 'President (disambiguation)', extract: 'President may refer to:', fullurl: 'https://en.wikipedia.org/wiki/President_(disambiguation)' },
      } } }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/brave') {
      server.lastSearch = { q: url.searchParams.get('q'), token: req.headers['x-subscription-token'] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ web: { results: [
        { title: 'Mock Source One', url: 'https://example.com/one', description: 'MOCK SNIPPET ALPHA about the question.' },
        { title: 'Mock Source Two', url: 'https://example.org/two', description: 'MOCK SNIPPET BETA with more detail.' },
      ] } }));
      return;
    }

    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        server.lastRequest = { auth: req.headers.authorization, model: parsed.model, messages: parsed.messages, stream: parsed.stream };
        const sorting = parsed.messages.some((m) => m.role === 'system' && /You sort bookmarks/.test(m.content));
        const expanding = parsed.messages.some((m) => m.role === 'system' && /You expand search terms/.test(m.content));
        const drawing = parsed.messages.some((m) => m.role === 'system' && /You edit a drawing/.test(m.content));
        // The Writing widget: a distill call gets a profile under the headings it asked for; a run gets a line with an
        // em dash in it, so the test can see the register's "no em dashes" rule enforced after generation.
        const distilling = parsed.messages.some((m) => m.role === 'system' && /You are a voice analyst/.test(m.content));
        const voicing = parsed.messages.some((m) => m.role === 'system' && /sounds like a specific author/.test(m.content));
        const lastUserRaw = [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        const lastUser = typeof lastUserRaw === 'string' ? lastUserRaw : lastUserRaw.map((c) => c.text ?? '').join(' ');
        // The Notebook sends a photo as an image_url part and does not stream; it gets the "transcription" as JSON.
        const hasImage = Array.isArray(lastUserRaw) && lastUserRaw.some((c) => c.type === 'image_url' && /^data:image\/jpeg;base64,/.test(c.image_url?.url ?? ''));
        server.lastRequest.hasImage = hasImage;
        if (!parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: hasImage ? 'MOCK OCR TEXT\nSecond line from the photo' : 'non-streamed mock' } }] }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        // The Canvas asks for shapes; the reply keeps the user's first stroke by id, so the test sees it survive.
        const pathId = (lastUser.match(/"type":"path","id":"([^"]+)"/) || [])[1];
        const words = drawing ? [JSON.stringify({ shapes: [{ type: 'rect', x: 100, y: 80, w: 200, h: 120, color: '#2b6fd6' }, { type: 'text', x: 110, y: 240, text: 'House', size: 24, color: '#1f1a17' }, ...(pathId ? [{ type: 'path', id: pathId }] : [])] })]
          : distilling ? ['### Diction & vocabulary', '\nShort words, plain verbs; "honestly" once per piece.', '\n\n### Sentence rhythm', '\nLong then short.', '\n\n### What this author would never do', '\nOpen with "Hey everyone!".']
          : voicing ? ['Sounds', ' like', ' you —', ' and', ' nobody', ' else', '.']
          : expanding ? ['recipe', ', kitchen', ', chef', ', risotto', ', seriouseats'] : sorting ? ['1', ', ', '3']
          : /markdown test/i.test(lastUser) ? ['### Title', '\n\n- **one**', '\n- two', '\n\nUse `code`', ' here.']
          : ['The', ' mock', ' cloud', ' says', ' hello', ' from', ` ${parsed.model}`, ' [1]', '.'];
        let i = 0;
        const tick = setInterval(() => {
          if (i < words.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i++] } }] })}\n\n`);
          else { clearInterval(tick); res.write('data: [DONE]\n\n'); res.end(); }
        }, 15);
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMockServer(Number(process.env.PORT || 0));
  console.log(`mock server on http://127.0.0.1:${port} (POST /v1/chat/completions, GET /brave)`);
}

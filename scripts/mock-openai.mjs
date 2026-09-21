// Local stand-ins for the network the extension talks to in cloud and grounded modes.
//   POST /v1/chat/completions  OpenAI-compatible SSE stream; records the last request.
//   GET  /brave?q=             Brave Search API shape with two fixed results.
// Both send CORS headers so the extension page can call them without a host permission, as real APIs do.
import { createServer } from 'node:http';

export function startMockServer(port = 0) {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, accept, x-subscription-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');

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
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const sorting = parsed.messages.some((m) => m.role === 'system' && /You sort bookmarks/.test(m.content));
        const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        const words = sorting ? ['1', ', ', '3']
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

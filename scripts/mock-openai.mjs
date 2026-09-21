// Minimal OpenAI-compatible server for the cloud-mode smoke test. Streams a fixed answer as SSE.
// Exposes CORS so the extension page can call it without a host permission, exactly like a real API would.
import { createServer } from 'node:http';

export function startMockOpenAI(port = 0) {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      server.lastRequest = { auth: req.headers.authorization, model: parsed.model, messages: parsed.messages, stream: parsed.stream };
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const words = ['The', ' mock', ' cloud', ' says', ' hello', ' from', ` ${parsed.model}`, '.'];
      let i = 0;
      const tick = setInterval(() => {
        if (i < words.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i++] } }] })}\n\n`);
        } else {
          clearInterval(tick);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 20);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMockOpenAI(Number(process.env.PORT || 0));
  console.log(`mock OpenAI listening on http://127.0.0.1:${port}/v1`);
}

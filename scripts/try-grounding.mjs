// Runs the free grounding provider against the real DuckDuckGo and Wikipedia APIs from Node (type stripping).
// Usage: node scripts/try-grounding.mjs "Who is the US president?" "What is OPFS?"
import { searchWeb } from '../lib/grounding.ts';
// Wikipedia's API policy wants an identifying User-Agent; a browser supplies one, Node does not.
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o = {}) => realFetch(u, { ...o, headers: { ...(o.headers || {}), 'User-Agent': 'Fogar grounding probe (https://fogar.ai)' } });
const g = { provider: 'free', apiKey: '', byDefault: false };
const questions = process.argv.slice(2).length ? process.argv.slice(2) : ['Who is the US president?', 'What is OPFS?', 'the micro startups guy'];
for (const q of questions) {
  const t0 = Date.now();
  try {
    const sources = await searchWeb(q, g, new AbortController().signal);
    console.log(`\n"${q}" → ${sources.length} sources in ${Date.now() - t0} ms`);
    for (const s of sources) console.log(`  [${s.via}] ${s.title}\n      ${s.snippet.slice(0, 110).replace(/\n/g, ' ')}…`);
  } catch (err) { console.log(`\n"${q}" → ERROR ${err.message}`); }
}

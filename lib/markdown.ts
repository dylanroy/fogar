/**
 * A small, safe Markdown renderer for model output. Builds DOM nodes directly; never sets innerHTML from
 * model text. Supports headings, paragraphs, bullet and numbered lists, fenced code, inline code, bold,
 * italic, blockquotes, rules, and http(s) links. Anything else renders as plain text.
 */
const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;

function inline(text: string, into: Node): void {
  // Tokens: `code`, **bold**, *italic* or _italic_, [text](url)
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) into.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) { const c = document.createElement('code'); c.textContent = m[1].slice(1, -1); into.appendChild(c); }
    else if (m[2]) { const b = document.createElement('strong'); inline(m[2].slice(2, -2), b); into.appendChild(b); }
    else if (m[3]) { const i = document.createElement('em'); inline(m[3].slice(1, -1), i); into.appendChild(i); }
    else if (m[4]) {
      const label = m[4].slice(1, m[4].indexOf(']('));
      const url = m[5]!;
      if (SAFE_URL.test(url)) { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label; into.appendChild(a); }
      else into.appendChild(document.createTextNode(m[4]));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) into.appendChild(document.createTextNode(text.slice(last)));
}

export function renderMarkdown(src: string, into: HTMLElement): void {
  into.replaceChildren();
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement('p'); inline(para.join(' '), p); into.appendChild(p); para = [];
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
      const code: string[] = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      i++; // closing fence (or end of input while streaming)
      const pre = document.createElement('pre'); const c = document.createElement('code');
      if (fence[1]) c.dataset.lang = fence[1];
      c.textContent = code.join('\n'); pre.appendChild(c); into.appendChild(pre);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (heading) { flushPara(); const h = document.createElement(`h${heading[1]!.length + 2}` as 'h3'); inline(heading[2]!, h); into.appendChild(h); i++; continue; }
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) { flushPara(); into.appendChild(document.createElement('hr')); i++; continue; }
    if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[i]!) : /^\s*[-*•]\s+/.test(lines[i]!))) {
        const li = document.createElement('li');
        let item = lines[i]!.replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/, '');
        i++;
        // continuation lines indented under the item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) item += ' ' + lines[i++]!.trim();
        inline(item, li); list.appendChild(li);
      }
      into.appendChild(list); continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const q = document.createElement('blockquote'); const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^>\s?/, ''));
      const p = document.createElement('p'); inline(quoted.join(' '), p); q.appendChild(p); into.appendChild(q); continue;
    }
    if (line.trim() === '') { flushPara(); i++; continue; }
    para.push(line.trim()); i++;
  }
  flushPara();
}

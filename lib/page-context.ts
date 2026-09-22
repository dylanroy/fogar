/** What a right-click question carries with it: where the user was, and the text around what they selected. */
export interface PageContext {
  title: string;
  url: string;
  selection: string;
  excerpt: string;
}

/**
 * Runs INSIDE the web page through scripting.executeScript, so it must stay self-contained: no imports, no
 * references to anything outside its own body. It returns the page title, address, the current selection, and
 * about 1,500 characters of text around it, taken from the nearest block that contains the selection.
 */
export function extractPageContext(selectionText: string): PageContext {
  const LIMIT = 1500;
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  let selection = clean(selectionText || '');
  let excerpt = '';
  const around = (text: string, needle: string) => {
    const at = needle ? text.indexOf(needle) : -1;
    if (at < 0) return text.slice(0, LIMIT);
    const start = Math.max(0, at - Math.floor((LIMIT - needle.length) / 2));
    return text.slice(start, start + LIMIT);
  };
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.toString().trim()) {
      selection = clean(sel.toString());
      let node: Node | null = sel.getRangeAt(0).commonAncestorContainer;
      if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
      // Walk up until the block holds enough text to be useful context, but stop before the whole page.
      let block = node as HTMLElement | null;
      while (block && block !== document.body && (block.innerText || '').length < 400) block = block.parentElement;
      excerpt = around(clean((block && block !== document.body ? block.innerText : document.body.innerText) || ''), selection);
    } else if (selection) {
      // The selection can be gone by the time the menu item runs; the words still tell us where to look.
      const body = clean(document.body?.innerText || '');
      const bare = selection.replace(/^["“”'‘’«»]+|["“”'‘’«»]+$/g, '');
      excerpt = around(body, body.includes(bare) ? bare : '');
    }
  } catch {
    /* a page that blocks selection access still gets title and URL */
  }
  if (!excerpt) {
    const meta = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
    excerpt = clean(meta?.content || '');
  }
  return { title: clean(document.title || ''), url: location.href, selection, excerpt };
}

/** The system-prompt block that puts the page in front of the model. */
export function contextBlock(ctx: PageContext): string {
  const where = ctx.title ? `"${ctx.title}" (${ctx.url})` : ctx.url;
  const excerpt = ctx.excerpt ? `\n\nExcerpt from that page, around the user's selection:\n"""\n${ctx.excerpt}\n"""` : '';
  return `The user was reading the page ${where} and selected: "${ctx.selection}". Answer from the page when it is relevant, and say when the page does not contain the answer.${excerpt}`;
}

export const CTX_KEY = (id: string) => `fogar.ctx.${id}`;

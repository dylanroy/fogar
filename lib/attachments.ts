import { strFromU8, unzipSync } from 'fflate';
// pdf.js runs its parser in a worker. Manifest V3 allows no blob: workers and no remote code, so the worker
// ships as a static file inside the extension, the same way the wllama workers do.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export type AttachmentKind = 'text' | 'pdf' | 'docx' | 'html';

/** A file the user attached to a question: its text, and how much of the file that text is. */
export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** Extracted text, already cut to the budget it was read with. */
  text: string;
  /** Words seen and words kept. For a PDF, "seen" covers the pages read, not the whole file. */
  words: number;
  wordsKept: number;
  /** PDFs: pages in the file, and pages read before the budget ran out. */
  pages?: number;
  pagesRead?: number;
  truncated: boolean;
}

/**
 * Characters of document text one question can carry. The local models run with a 4,096-token window shared by
 * the system prompt, the conversation, the document, and a 768-token answer, so about 6,500 characters (roughly
 * 1,200 words, two to three pages) is what fits with room to spare for token-dense text such as tables. Cloud
 * endpoints have room for much more, though not a book: Ollama's default window is small, and a huge prompt is
 * slow and costs money again on every follow-up.
 */
export const ATTACHMENT_BUDGET = { local: 6500, cloud: 40000 } as const;
/** The local budget as words, rounded down to the hundred, for copy that explains it. */
export const LOCAL_BUDGET_WORDS = Math.floor(ATTACHMENT_BUDGET.local / 5.2 / 100) * 100;

const MAX_BYTES = 40 * 1024 * 1024;
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const TEXT_EXT = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log', 'ics', 'srt', 'vtt', 'tex', 'rst', 'ini', 'toml', 'cfg', 'conf', 'sql', 'py', 'js', 'ts', 'css', 'sh']);

export const countWords = (s: string): number => (s.match(/\S+/g) ?? []).length;
export const fmt = (n: number): string => n.toLocaleString();

const clean = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Cut at a word boundary near the budget. */
function cut(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  let end = text.lastIndexOf(' ', budget);
  if (end < budget * 0.8) end = budget;
  return { text: text.slice(0, end).trimEnd(), truncated: true };
}

const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/** What a file is, by extension first and MIME type second; drag-and-drop often reports neither reliably. */
export function kindOf(file: File): AttachmentKind | 'image' | 'unsupported' {
  const ext = extOf(file.name);
  const type = (file.type || '').toLowerCase();
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (ext === 'docx' || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (ext === 'html' || ext === 'htm' || type === 'text/html') return 'html';
  if (type.startsWith('image/')) return 'image';
  if (TEXT_EXT.has(ext) || type.startsWith('text/') || type === 'application/json' || type === 'application/xml') return 'text';
  return 'unsupported';
}

/** The kind of a file Fogar can read, or a thrown sentence saying why it cannot, before any bytes are touched. */
export function assertReadable(file: File): AttachmentKind {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is over 40 MB. Fogar reads documents, not archives.`);
  const kind = kindOf(file);
  if (kind === 'image') throw new Error('Fogar reads text, not images, yet. A PDF with a text layer, a Word file, or plain text works.');
  if (kind === 'unsupported') {
    const ext = extOf(file.name);
    if (ext === 'doc') throw new Error('Old .doc files are not supported. Save it as .docx or PDF first.');
    if (['xlsx', 'xls', 'numbers', 'ods'].includes(ext)) throw new Error('Spreadsheets are not supported yet. Export a CSV instead.');
    if (['pptx', 'ppt', 'key'].includes(ext)) throw new Error('Slides are not supported yet. Export a PDF instead.');
    throw new Error(`Fogar cannot read ${ext ? `.${ext} files` : 'that file'}. PDF, Word (.docx), and plain text work.`);
  }
  return kind;
}

/** Read one file into text cut to `budget` characters. Failures throw a sentence the UI can show as it is. */
export async function extractAttachment(file: File, budget: number): Promise<Attachment> {
  const kind = assertReadable(file);
  const base = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, name: file.name, kind };
  if (kind === 'pdf') return { ...base, ...(await readPdf(file, budget)) };
  const full = clean(kind === 'docx' ? await readDocx(file) : kind === 'html' ? readHtml(await file.text()) : await file.text());
  if (!full) throw new Error(`${file.name} has no text to read.`);
  const c = cut(full, budget);
  return { ...base, text: c.text, words: countWords(full), wordsKept: countWords(c.text), truncated: c.truncated };
}

const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'TABLE', 'BR', 'HR', 'DT', 'DD', 'FIGCAPTION', 'ASIDE', 'NAV', 'MAIN']);
const CELL = new Set(['TD', 'TH']);

/** A saved web page: the text as it reads, one line per block, scripts and styles gone. */
function readHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const n of doc.querySelectorAll('script,style,noscript,template,svg,head')) n.remove();
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { out.push(node.textContent ?? ''); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName;
    if (BLOCK.has(tag)) out.push('\n');
    for (const c of Array.from(node.childNodes)) walk(c);
    out.push(BLOCK.has(tag) ? '\n' : CELL.has(tag) ? ' ' : '');
  };
  walk(doc.body ?? doc.documentElement);
  const title = doc.title?.trim();
  return (title ? `${title}\n\n` : '') + out.join('');
}

/** A .docx is a zip with the text in word/document.xml: one w:p per paragraph, the words in w:t runs. */
async function readDocx(file: File): Promise<string> {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(new Uint8Array(await file.arrayBuffer())); } catch { throw new Error(`${file.name} is not a Word file Fogar can open.`); }
  const part = files['word/document.xml'];
  if (!part) throw new Error(`${file.name} has no document inside. Is it really a .docx?`);
  const xml = new DOMParser().parseFromString(strFromU8(part), 'application/xml');
  const paragraphs: string[] = [];
  for (const p of Array.from(xml.getElementsByTagNameNS(W_NS, 'p'))) {
    let line = '';
    const walk = (n: Node) => {
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const e = n as Element;
      if (e.namespaceURI !== W_NS) { for (const c of Array.from(e.childNodes)) walk(c); return; }
      if (e !== p && e.localName === 'p') return; // a text box inside a paragraph is listed on its own
      if (e.localName === 't') { line += e.textContent ?? ''; return; }
      if (e.localName === 'tab') { line += '\t'; return; }
      if (e.localName === 'br' || e.localName === 'cr') { line += '\n'; return; }
      for (const c of Array.from(e.childNodes)) walk(c);
    };
    walk(p);
    paragraphs.push(line);
  }
  return paragraphs.join('\n');
}

/**
 * PDF text through pdf.js, page by page, stopping once the budget is full so a 300-page manual costs the time
 * of its first pages. Scans have no text layer and are refused with a reason; Fogar has no OCR.
 */
async function readPdf(file: File, budget: number): Promise<Omit<Attachment, 'id' | 'name' | 'kind'>> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  // Text only: no font faces, no system fonts, no prefetching of the rest of the file.
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), disableFontFace: true, useSystemFonts: false, disableAutoFetch: true });
  let doc: import('pdfjs-dist').PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (err) {
    void task.destroy();
    throw new Error((err as Error)?.name === 'PasswordException' ? `${file.name} is password-protected.` : `${file.name} could not be opened as a PDF.`);
  }
  try {
    const parts: string[] = [];
    let chars = 0; let pagesRead = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== 'string') continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      page.cleanup();
      const cleaned = clean(text);
      if (cleaned) { parts.push(cleaned); chars += cleaned.length + 2; pagesRead = i; }
      if (chars >= budget) break;
    }
    const full = parts.join('\n\n');
    if (!full) throw new Error(`${file.name} has no text layer; it is probably a scan. Fogar cannot read images yet.`);
    const c = cut(full, budget);
    return { text: c.text, words: countWords(full), wordsKept: countWords(c.text), pages: doc.numPages, pagesRead, truncated: c.truncated || pagesRead < doc.numPages };
  } finally {
    void task.destroy();
  }
}

/** What the chip says next to the file name. */
export function describeAttachment(a: Attachment): string {
  if (a.kind === 'pdf') {
    const pages = `${fmt(a.pages ?? 0)} page${a.pages === 1 ? '' : 's'}`;
    return a.truncated ? `${pages} · read the first ${fmt(a.pagesRead ?? 0)}` : pages;
  }
  return a.truncated ? `read the first ${fmt(a.wordsKept)} of ${fmt(a.words)} words` : `${fmt(a.words)} word${a.words === 1 ? '' : 's'}`;
}

/**
 * The system-prompt block that puts the files in front of the model. `budget` re-cuts if the files were read for
 * one mode and the question is asked in the other, so a cloud-sized read never overflows the local window.
 */
export function attachmentBlock(list: Attachment[], budget: number): string {
  let left = budget;
  const parts: string[] = [];
  for (const a of list) {
    const c = cut(a.text, Math.max(0, left));
    left -= c.text.length;
    if (!c.text) continue;
    const truncated = a.truncated || c.truncated;
    const scope = a.kind === 'pdf'
      ? `${fmt(a.pages ?? 0)} page${a.pages === 1 ? '' : 's'}${truncated ? `; only the first ${fmt(a.pagesRead ?? 0)} ${a.pagesRead === 1 ? 'page is' : 'pages are'} included below` : ''}`
      : truncated ? `about ${fmt(countWords(c.text))} of ${fmt(a.words)} words; the rest is not included` : `${fmt(a.words)} words`;
    parts.push(`File "${a.name}" (${scope}):\n"""\n${c.text}\n"""`);
  }
  if (!parts.length) return '';
  const one = parts.length === 1;
  return `The user attached ${one ? 'a file' : `${parts.length} files`}. When the question is about ${one ? 'it' : 'them'}, answer from the text below, quote figures and names exactly as written, and say plainly when the file does not contain the answer.\n\n${parts.join('\n\n')}`;
}

import type { WidgetInstance } from '@/lib/layout';
import { clear, debounce, el } from '@/lib/dom';
import { getItem, setItem, uid } from '@/lib/store';
import { downloadFile } from '@/lib/backup';
import { loadProfiles, type ModelProfile } from '@/lib/chat-models';
import { prepareImage, recognizeLocal, recognizeWithModel, type VisionTarget } from '@/lib/ocr';
import { hasFiles } from '../ui/attach';
import { cacheKey, field, isImageFile, setupForm, type WidgetCtx, type WidgetDef } from './shared';

/**
 * Notebook: ruled pages you type on, and a camera button. A photo of a notebook page, a whiteboard, or a
 * receipt is read into text on the current page: on this device with Tesseract (printed text), or by a vision
 * model you connected (handwriting). Pages live in extension storage and ride along in backups.
 */
interface Page { id: string; title: string; text: string; createdAt: number; updatedAt: number }
interface NotebookData { pages: Page[]; current: string }

const newPage = (n: number): Page => ({ id: uid(), title: `Page ${n}`, text: '', createdAt: Date.now(), updatedAt: Date.now() });

type ReaderId = 'local' | 'fogar-cloud' | string;
interface Reader { id: ReaderId; label: string; target: VisionTarget | null }

/** What can read a photo: Tesseract here, the cloud endpoint from Settings, and any profile marked as reading images. */
function readers(ctx: WidgetCtx, profiles: ModelProfile[]): Reader[] {
  const out: Reader[] = [{ id: 'local', label: 'On this device · printed text, English', target: null }];
  if (ctx.app.cloudConfigured()) out.push({ id: 'fogar-cloud', label: `Fogar cloud · ${ctx.app.settings.cloud.model}`, target: { kind: 'openai', ...ctx.app.settings.cloud } });
  for (const p of profiles) if (p.vision && p.endpoint && p.model) out.push({ id: p.id, label: `${p.name} · ${p.model}`, target: { kind: p.kind, endpoint: p.endpoint, apiKey: p.apiKey, model: p.model } });
  return out;
}

export const notebook: WidgetDef = {
  type: 'notebook', title: 'Notebook', description: 'Ruled pages. Photograph a handwritten page and it becomes text.', single: false,
  defaultConfig: () => ({ name: 'Notebook', reader: 'local' }),
  name: (inst) => inst.config.name || 'Notebook',
  async render(body, actions, inst, ctx) {
    let data = await getItem<NotebookData | null>(cacheKey(inst), null);
    if (!data || !Array.isArray(data.pages) || !data.pages.length) { const p = newPage(1); data = { pages: [p], current: p.id }; }
    const d: NotebookData = data;
    // Typing is debounced; adding, deleting, or switching a page is written at once.
    const writeNow = () => void setItem(cacheKey(inst), d);
    const save = debounce(writeNow, 400);
    const current = () => d.pages.find((p) => p.id === d.current) ?? d.pages[0]!;

    const tabs = el('div', { class: 'nb-tabs', role: 'tablist' });
    const title = el('input', { class: 'nb-title', type: 'text', placeholder: 'Untitled page', 'aria-label': 'Page title' } as any);
    const text = el('textarea', { class: 'nb-text', placeholder: 'Write here, or add a photo of a page below.', spellcheck: false });
    const status = el('span', { class: 'nb-status muted' });
    const file = el('input', { class: 'nb-file', type: 'file', accept: 'image/*', hidden: true });
    const photoBtn = el('button', { class: 'ghost small nb-photo', type: 'button', title: 'Photograph or pick an image of a page; its text lands here', onclick: () => file.click() }, '📷 Add a photo');
    const reader = el('select', { class: 'line-input nb-reader', title: 'What reads the photo' });
    const grow = () => { text.style.height = 'auto'; text.style.height = `${Math.max(280, text.scrollHeight + 8)}px`; };

    const paintTabs = () => {
      clear(tabs);
      d.pages.forEach((p) => tabs.append(el('button', {
        class: `nb-tab${p.id === d.current ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(p.id === d.current), title: p.title,
        onclick: () => { d.current = p.id; writeNow(); paintPage(); },
      } as any, p.title || 'Untitled')));
      tabs.append(el('button', { class: 'nb-tab nb-add', type: 'button', title: 'New page', onclick: () => { const p = newPage(d.pages.length + 1); d.pages.push(p); d.current = p.id; writeNow(); paintPage(); title.focus(); } }, '+'));
    };
    const paintPage = () => {
      const p = current();
      title.value = p.title; text.value = p.text;
      paintTabs(); requestAnimationFrame(grow);
    };
    title.addEventListener('input', () => { const p = current(); p.title = title.value; p.updatedAt = Date.now(); paintTabs(); save(); });
    text.addEventListener('input', () => { const p = current(); p.text = text.value; p.updatedAt = Date.now(); grow(); save(); });
    text.addEventListener('blur', writeNow); // leaving the page writes it now, not after the debounce

    const profiles = await loadProfiles();
    const list = readers(ctx, profiles);
    for (const r of list) reader.append(new Option(r.label, r.id, false, r.id === (inst.config.reader ?? 'local')));
    if (!list.some((r) => r.id === reader.value)) reader.value = 'local';
    reader.onchange = async () => { inst.config.reader = reader.value; await ctx.save(inst); };

    const append = (t: string) => {
      const p = current();
      const cur = text.value.trimEnd();
      text.value = cur ? `${cur}\n\n${t}` : t;
      p.text = text.value; p.updatedAt = Date.now(); grow(); save();
    };
    let busy = false;
    const read = async (f: File) => {
      if (busy) return;
      if (!isImageFile(f)) { ctx.app.toast('That is not an image. A photo, screenshot, or scan works.'); return; }
      const r = list.find((x) => x.id === reader.value) ?? list[0]!;
      busy = true; photoBtn.disabled = true; status.textContent = 'Preparing the photo…';
      try {
        if (!r.target) {
          const img = await prepareImage(f, { enhance: true });
          const out = await recognizeLocal(img, (p) => { status.textContent = `${p.status.replace(/^loading /, 'loading ')}${p.progress > 0 && p.progress < 1 ? ` ${Math.round(p.progress * 100)}%` : ''}`; });
          if (!out.trim()) { status.textContent = 'No text found. Handwriting needs a vision model; pick one in the list.'; return; }
          append(out); status.textContent = `Read ${out.split(/\s+/).filter(Boolean).length} words on this device.`;
        } else {
          const img = await prepareImage(f);
          status.textContent = `Reading with ${r.label.split(' · ')[0]}…`;
          const out = await recognizeWithModel(img, r.target);
          append(out); status.textContent = `Read ${out.split(/\s+/).filter(Boolean).length} words with ${r.label.split(' · ')[0]}.`;
        }
      } catch (err) {
        status.textContent = (err as Error).message;
      } finally {
        busy = false; photoBtn.disabled = false;
      }
    };
    file.onchange = () => { const f = file.files?.[0]; if (f) void read(f); file.value = ''; };
    text.addEventListener('paste', (e) => { const f = Array.from(e.clipboardData?.files ?? []).find(isImageFile); if (f) { e.preventDefault(); void read(f); } });
    text.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); text.classList.add('drop'); });
    text.addEventListener('dragleave', () => text.classList.remove('drop'));
    text.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); text.classList.remove('drop'); const f = Array.from(e.dataTransfer!.files).find(isImageFile); if (f) void read(f); else ctx.app.toast('Drop an image of a page here.'); });

    const copyBtn = el('button', { class: 'ctl', type: 'button', title: 'Copy this page', onclick: async () => { await navigator.clipboard.writeText(text.value); ctx.app.toast('Page copied'); } }, '⎘');
    const exportBtn = el('button', { class: 'ctl', type: 'button', title: 'Download the notebook as Markdown', onclick: () => {
      const md = d.pages.map((p) => `# ${p.title || 'Untitled'}\n\n${p.text}\n`).join('\n');
      downloadFile(`${(inst.config.name || 'notebook').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`, md, 'text/markdown');
    } }, '⇩');
    const deleteBtn = el('button', { class: 'ctl', type: 'button', title: 'Delete this page', onclick: () => {
      const p = current();
      if ((p.text.trim() || p.title.trim()) && !confirm(`Delete “${p.title || 'Untitled'}”?`)) return;
      d.pages = d.pages.filter((x) => x !== p);
      if (!d.pages.length) d.pages.push(newPage(1));
      d.current = d.pages[Math.max(0, Math.min(d.pages.length - 1, d.pages.indexOf(p)))]?.id ?? d.pages[0]!.id;
      if (!d.pages.some((x) => x.id === d.current)) d.current = d.pages[0]!.id;
      writeNow(); paintPage();
    } }, '🗑');
    actions.append(copyBtn, exportBtn, deleteBtn);

    body.append(
      el('div', { class: 'nb' }, tabs, el('div', { class: 'nb-page' }, title, text)),
      el('div', { class: 'nb-foot' }, photoBtn, file, el('span', { class: 'muted' }, 'read with'), reader, status),
    );
    paintPage();
  },
  configure(body, inst, ctx) {
    const name = el('input', { class: 'line-input', type: 'text', value: inst.config.name ?? 'Notebook' });
    clear(body);
    body.append(
      el('p', { class: 'muted' }, 'Reading on this device uses Tesseract, shipped inside Fogar with English data; it is good on printed text and poor on handwriting. For handwriting, connect a model that reads images in an LLM Chat widget (Anthropic, OpenAI, Gemini, or a vision model on Ollama) and pick it under “read with”. The photo goes only to that endpoint and is not stored.'),
      setupForm([field('Title', name)], async () => { inst.config.name = name.value.trim() || 'Notebook'; await ctx.save(inst); ctx.remount(inst); }, () => ctx.remount(inst)),
    );
  },
};

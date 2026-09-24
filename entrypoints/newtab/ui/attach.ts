import type { App } from '../app';
import { ATTACHMENT_BUDGET, assertReadable, describeAttachment, extractAttachment, type Attachment } from '@/lib/attachments';

/** True for a drag or drop that carries files. While dragging, `files` is empty for privacy; `types` still says. */
export const hasFiles = (e: DragEvent): boolean => {
  const dt = e.dataTransfer;
  return !!dt && (Array.from(dt.types ?? []).includes('Files') || dt.files.length > 0);
};

/** How much document text a question can carry in the current mode. */
export const budgetFor = (app: App): number => ATTACHMENT_BUDGET[app.settings.mode];

/**
 * Read files one after another into `into`, sharing one budget between them. A file that cannot be read becomes
 * a toast; the ones that can still land.
 */
export async function readFiles(app: App, files: Iterable<File>, into: Attachment[]): Promise<Attachment[]> {
  const budget = budgetFor(app);
  const added: Attachment[] = [];
  for (const f of files) {
    // A file Fogar cannot read at all gets that reason, whatever the budget says.
    try { assertReadable(f); } catch (err) { app.toast((err as Error).message); continue; }
    const used = into.reduce((n, a) => n + a.text.length, 0);
    const left = budget - used;
    if (left < 400) { app.toast(`That is as much as the model can read at once. Remove a file to add ${f.name}.`); break; }
    try {
      const a = await extractAttachment(f, left);
      into.push(a); added.push(a);
    } catch (err) {
      app.toast((err as Error).message);
    }
  }
  return added;
}

/** A field that takes a dropped or pasted file and fills itself with the text, as a paste would. */
export function acceptFilesInto(area: HTMLTextAreaElement, app: App): void {
  const fill = async (files: FileList) => {
    const list: Attachment[] = [];
    await readFiles(app, Array.from(files), list);
    if (!list.length) return;
    const text = list.map((a) => a.text).join('\n\n');
    area.value = area.value.trim() ? `${area.value.trimEnd()}\n\n${text}` : text;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    const short = list.filter((a) => a.truncated);
    if (short.length) app.toast(`Kept what fits. ${short.map((a) => `${a.name}: ${describeAttachment(a)}`).join(' · ')}`);
    void app.ensureModel();
  };
  area.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); area.classList.add('drop'); });
  area.addEventListener('dragleave', () => area.classList.remove('drop'));
  area.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); area.classList.remove('drop'); void fill(e.dataTransfer!.files); });
  area.addEventListener('paste', (e) => { const files = e.clipboardData?.files; if (files && files.length) { e.preventDefault(); void fill(files); } });
}

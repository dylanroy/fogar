import type { WidgetInstance } from '@/lib/layout';
import { clear, debounce, el } from '@/lib/dom';
import { uid } from '@/lib/store';
import { field, setupForm, type WidgetCtx, type WidgetDef } from './shared';

/**
 * Post-its: square notes on a board. Drag one by its top edge to move it; new notes land on a stack, and
 * pulling one off the stack puts it wherever you let go. Let go over another board and the note moves there;
 * let go anywhere else on the page and the note becomes a widget of its own, next to the card it landed on.
 */
export interface Sticky { id: string; text: string; color: string; x: number; y: number; rot: number }

export const STICKY_COLORS = ['#fff3a3', '#ffc9d6', '#c7f0c4', '#bfe3ff', '#ffd9a8', '#e5d4ff'];
const NOTE_MIN_H = 150; const BOARD_MIN_H = 240;

const notesOf = (inst: WidgetInstance): Sticky[] => (Array.isArray(inst.config.notes) ? inst.config.notes : []);
export const newSticky = (n: number, x = 12 + (n % 3) * 14, y = 12 + (n % 3) * 12): Sticky =>
  ({ id: uid(), text: '', color: STICKY_COLORS[n % STICKY_COLORS.length]!, x, y, rot: ((n * 7) % 5) - 2 });

export const postit: WidgetDef = {
  type: 'postit', title: 'Post-its', description: 'Sticky notes you can drag around, stack, and pull off into their own widget.', single: false, fill: true,
  defaultConfig: () => ({ name: 'Post-its', notes: [newSticky(0)] }),
  name: (inst) => inst.config.name || 'Post-its',
  render(body, actions, inst, ctx) {
    const notes = notesOf(inst); inst.config.notes = notes;
    const board = el('div', { class: 'board', dataset: { inst: inst.id } });
    const save = debounce(() => void ctx.save(inst), 300);
    let zTop = notes.length;

    const fitBoard = () => {
      let bottom = 0;
      for (const n of board.querySelectorAll<HTMLElement>('.pnote')) bottom = Math.max(bottom, n.offsetTop + n.offsetHeight);
      board.style.minHeight = `${Math.max(BOARD_MIN_H, bottom + 20)}px`;
    };

    const noteEl = (note: Sticky): HTMLElement => {
      const ta = el('textarea', { class: 'pnote-text', placeholder: 'Write…', value: note.text, spellcheck: false });
      const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.max(NOTE_MIN_H - 28, ta.scrollHeight)}px`; fitBoard(); };
      ta.addEventListener('input', () => { note.text = ta.value; grow(); save(); });
      ta.addEventListener('blur', () => void ctx.save(inst)); // leaving the note writes it now, not after the debounce
      const dots = el('span', { class: 'pnote-colors' });
      for (const c of STICKY_COLORS) dots.append(el('button', { class: `dot${c === note.color ? ' on' : ''}`, type: 'button', title: 'Colour', style: `--paper:${c}`, onclick: (e: MouseEvent) => { e.stopPropagation(); note.color = c; node.style.setProperty('--paper', c); for (const d of dots.children) d.classList.toggle('on', (d as HTMLElement).style.getPropertyValue('--paper') === c); save(); } }));
      const bar = el('div', { class: 'pnote-bar', title: 'Drag to move. Drop on another board to move it there, or anywhere else on the page to make it its own widget.' },
        dots, el('button', { class: 'x', type: 'button', title: 'Remove this note', onclick: (e: MouseEvent) => { e.stopPropagation(); notes.splice(notes.indexOf(note), 1); node.remove(); fitBoard(); void ctx.save(inst); } }, '×'));
      const node = el('div', { class: 'pnote', dataset: { id: note.id }, style: `left:${note.x}px;top:${note.y}px;--paper:${note.color};--rot:${note.rot}deg` }, bar, ta);
      bar.addEventListener('pointerdown', (e) => startDrag(e, note, node));
      requestAnimationFrame(grow);
      return node;
    };

    // ---- dragging ----
    const clearMarks = () => {
      for (const b of document.querySelectorAll<HTMLElement>('.board.drop-target')) b.classList.remove('drop-target');
      for (const c of document.querySelectorAll<HTMLElement>('.widget.drop-before, .widget.drop-after')) c.classList.remove('drop-before', 'drop-after');
      document.getElementById('widgets')?.classList.remove('drop-end');
    };
    type Target = { kind: 'board'; board: HTMLElement } | { kind: 'card'; card: HTMLElement; before: boolean } | { kind: 'grid' } | { kind: 'self' };
    const targetAt = (x: number, y: number, node: HTMLElement): Target => {
      node.style.pointerEvents = 'none';
      const under = document.elementFromPoint(x, y) as HTMLElement | null;
      node.style.pointerEvents = '';
      const ownCard = board.closest('.widget');
      const otherBoard = under?.closest<HTMLElement>('.board');
      if (otherBoard && otherBoard !== board) return { kind: 'board', board: otherBoard };
      if (otherBoard === board || (ownCard && under && ownCard.contains(under))) return { kind: 'self' };
      const card = under?.closest<HTMLElement>('#widgets .widget');
      if (card) { const r = card.getBoundingClientRect(); const wide = card.classList.contains('wide'); return { kind: 'card', card, before: wide ? y < r.top + r.height / 2 : x < r.left + r.width / 2 }; }
      if (under?.closest('#widgets, #corner')) return { kind: 'grid' };
      return { kind: 'self' };
    };
    function startDrag(e: PointerEvent, note: Sticky, node: HTMLElement) {
      // The whole bar drags, colour dots included; only the remove button is a button here.
      if (e.button !== 0 || (e.target as HTMLElement).closest('button.x')) return;
      e.preventDefault();
      const bar = e.currentTarget as HTMLElement;
      bar.setPointerCapture(e.pointerId);
      const r = node.getBoundingClientRect();
      const offX = e.clientX - r.left; const offY = e.clientY - r.top;
      const startX = e.clientX; const startY = e.clientY;
      let moved = false; let target: Target = { kind: 'self' };
      node.classList.add('lift'); node.style.zIndex = String(++zTop);
      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
        moved = true;
        const br = board.getBoundingClientRect();
        node.style.left = `${ev.clientX - offX - br.left}px`; node.style.top = `${ev.clientY - offY - br.top}px`;
        target = targetAt(ev.clientX, ev.clientY, node);
        clearMarks();
        if (target.kind === 'board') target.board.classList.add('drop-target');
        else if (target.kind === 'card') target.card.classList.add(target.before ? 'drop-before' : 'drop-after');
        else if (target.kind === 'grid') document.getElementById('widgets')?.classList.add('drop-end');
      };
      const onUp = async (ev: PointerEvent) => {
        bar.removeEventListener('pointermove', onMove); bar.removeEventListener('pointerup', onUp); bar.removeEventListener('pointercancel', onUp);
        node.classList.remove('lift'); clearMarks();
        if (!moved) return;
        const br = board.getBoundingClientRect();
        const dest = target; // a const copy keeps the narrowing inside the callbacks below
        if (dest.kind === 'board') {
          const other = ctx.instances().find((w) => w.id === dest.board.dataset.inst);
          if (other && other !== inst) {
            const or = dest.board.getBoundingClientRect();
            notes.splice(notes.indexOf(note), 1);
            const list: Sticky[] = Array.isArray(other.config.notes) ? other.config.notes : [];
            list.push({ ...note, x: Math.max(0, Math.round(ev.clientX - offX - or.left)), y: Math.max(0, Math.round(ev.clientY - offY - or.top)) });
            other.config.notes = list;
            await ctx.save(inst); ctx.remount(inst); ctx.remount(other);
            return;
          }
        }
        if (target.kind === 'card' || target.kind === 'grid') {
          notes.splice(notes.indexOf(note), 1);
          const near = target.kind === 'card' ? { id: target.card.dataset.id!, before: target.before } : null;
          await ctx.spawn('postit', { name: 'Post-it', notes: [{ ...note, x: 12, y: 12 }] }, near);
          return;
        }
        note.x = Math.max(0, Math.round(ev.clientX - offX - br.left)); note.y = Math.max(0, Math.round(ev.clientY - offY - br.top));
        node.style.left = `${note.x}px`; node.style.top = `${note.y}px`;
        fitBoard(); void ctx.save(inst);
      };
      bar.addEventListener('pointermove', onMove);
      bar.addEventListener('pointerup', onUp);
      bar.addEventListener('pointercancel', onUp);
    }

    const paint = () => { clear(board); for (const n of notes) board.append(noteEl(n)); requestAnimationFrame(fitBoard); };
    const add = () => {
      const n = newSticky(notes.length);
      // A new note lands a little off the newest one, like a pad: pull it away to unstack.
      const last = notes[notes.length - 1];
      if (last) { n.x = last.x + 14; n.y = last.y + 12; }
      notes.push(n); const node = noteEl(n); board.append(node); node.style.zIndex = String(++zTop);
      node.querySelector<HTMLTextAreaElement>('textarea')?.focus(); save();
    };
    actions.append(el('button', { class: 'ghost small pnote-add', type: 'button', onclick: add }, '+ Note'));
    body.append(board);
    paint();
  },
  configure(body, inst, ctx) {
    const name = el('input', { class: 'line-input', type: 'text', value: inst.config.name ?? 'Post-its' });
    clear(body);
    body.append(setupForm([field('Board name', name)], async () => { inst.config.name = name.value.trim() || 'Post-its'; await ctx.save(inst); ctx.remount(inst); }, () => ctx.remount(inst)));
  },
};

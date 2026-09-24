import type { WidgetInstance } from '@/lib/layout';
import { clear, debounce, el } from '@/lib/dom';
import { getItem, setItem, uid } from '@/lib/store';
import { choices, loadProfiles, providerFor, type ChoiceId } from '@/lib/chat-models';
import {
  AMENDMENT_MAX, HISTORY_MAX, LOCAL_PROFILE_CHARS, MAX_AMENDMENTS, OPS, OUTPUT_TOKENS, PROFILE_WORDS, SAMPLE_BUDGET, TEXT_BUDGET, cleanOutput,
  countWords, distillMessages, newRegister, normalizeVoiceData, samplesChangedSince, samplesThatFit, transformMessages, wantsNoEmDash,
  type Register, type Sample, type VoiceProfile,
} from '@/lib/voice';
import { acceptFilesInto } from '../ui/attach';
import { cacheKey, field, relTime, setupForm, type WidgetCtx, type WidgetDef } from './shared';

/**
 * Writing: rewrite, tighten, warm up, or draft text in your own voice. A better Draft & rewrite, because it
 * knows who is writing. The voice is distilled once from samples of your real writing into a profile that
 * rides along on every run; registers (Email, Chat, Essay, and any you add) are modes under that one voice,
 * with rules that are followed to the letter. Samples stay editable, and one-line corrections ride on top of the profile
 * and survive every distill; earlier profiles are kept. Samples, profile, registers, and the last run live in extension
 * storage, ride along in backups, and go to a model only when you press the button, and only to the model you
 * picked in the header. One widget is one voice: a second widget can carry a client's or a brand's.
 */
type View = 'write' | 'voice' | 'registers';
const SAMPLE_MAX = 20_000;
/** The voice engine this widget carries a light version of; the credit in the card's corner points there. */
const DICKENS_URL = 'https://dickens.ai/?ref=fogar';
const words = (chars: number) => Math.round(chars / 5.2 / 100) * 100;

export const writing: WidgetDef = {
  type: 'writing', title: 'Writing', description: 'Rewrite, tighten, or draft in your own voice, with registers for email, chat, essays, and any you add.', single: false,
  defaultConfig: () => ({ name: 'Writing', author: 'You', model: '' }),
  name: (inst) => inst.config.name || 'Writing',
  async render(body, actions, inst, ctx) {
    const { app } = ctx;
    let profiles = await loadProfiles();
    const d = normalizeVoiceData(await getItem(cacheKey(inst), null));
    // Typing is debounced; adding, deleting, distilling, and a finished run are written at once.
    const writeNow = () => void setItem(cacheKey(inst), d);
    const save = debounce(writeNow, 400);
    const register = (): Register | null => d.registers.find((r) => r.id === d.registerId) ?? null;
    let view: View = 'write';
    let abort: AbortController | null = null;
    /** Open the Voice view with the correction box focused: the way from a result that is not you to fixing it. */
    let focusAmend = false;

    // ---- which model writes: the device model, the Settings endpoint, or a profile added in an LLM Chat widget ----
    const pick = el('select', { class: 'line-input wr-model', title: 'Which model writes' });
    const paintPick = () => {
      clear(pick);
      const list = choices(app, profiles);
      if (!inst.config.model || !list.some((c) => c.id === inst.config.model)) inst.config.model = (list.find((c) => c.ready) ?? list[0]!).id;
      for (const c of list) pick.append(new Option(`${c.name}${c.ready ? '' : ' · not set up'}`, c.id, false, c.id === inst.config.model));
    };
    pick.addEventListener('change', async () => { inst.config.model = pick.value; await ctx.save(inst); });
    app.onReadyChange(() => { if (pick.isConnected) paintPick(); });
    paintPick();
    actions.append(pick);
    const isLocal = () => inst.config.model === 'fogar-local';
    const mode = () => (isLocal() ? 'local' : 'cloud') as 'local' | 'cloud';
    const modelName = () => choices(app, profiles).find((c) => c.id === inst.config.model)?.name ?? String(inst.config.model);
    /** A provider ready to answer, or a toast saying why not. */
    const ready = async () => {
      const id: ChoiceId = inst.config.model;
      const provider = providerFor(id, app, profiles);
      if (!provider) { app.toast(id === 'fogar-local' ? 'Pick a model in Settings first.' : 'That model is not set up. Add its key in an LLM Chat widget\'s settings.'); return null; }
      if (id === 'fogar-local') {
        if (app.isBusy()) { app.toast('The device model is busy answering the ask bar. Wait a moment or pick another model.'); return null; }
        if (!app.local.loaded && !(await app.ensureModel())) { app.toast('Load the device model in Settings first.'); return null; }
      }
      return provider;
    };

    // ---- three views under one small tab row ----
    const nav = el('div', { class: 'seg wr-nav', role: 'tablist' });
    const pane = el('div', { class: 'wr-pane' });
    const paintNav = () => {
      clear(nav);
      const tabs: Array<[View, string]> = [['write', 'Write'], ['voice', d.profile ? `Voice · v${d.profile.version}` : 'Voice'], ['registers', `Registers · ${d.registers.length}`]];
      for (const [v, label] of tabs) nav.append(el('button', { type: 'button', role: 'tab', 'aria-pressed': String(view === v), 'aria-selected': String(view === v), onclick: () => { if (view !== v) { view = v; paint(); } } } as any, label));
    };
    const paint = () => { paintNav(); clear(pane); if (view === 'write') paintWrite(); else if (view === 'voice') paintVoice(); else paintRegisters(); };

    // ---------- Write ----------
    function paintWrite() {
      const regSel = el('select', { class: 'line-input wr-register', title: 'Register: the same voice at a different formality and length' });
      regSel.append(new Option('No register', '', false, !d.registerId));
      for (const r of d.registers) regSel.append(new Option(r.name || 'Untitled', r.id, false, r.id === d.registerId));
      regSel.onchange = () => { d.registerId = regSel.value; writeNow(); paintPlaceholders(); };
      const ops = el('div', { class: 'seg wr-ops' });
      const paintOps = () => {
        clear(ops);
        for (const o of OPS) ops.append(el('button', { type: 'button', title: o.hint, 'aria-pressed': String(d.op === o.id), onclick: () => { d.op = o.id; writeNow(); paintOps(); paintPlaceholders(); } } as any, o.label));
      };
      paintOps();
      const text = el('textarea', { class: 'wr-text', value: d.input });
      const instr = el('input', { class: 'line-input wr-instruction', type: 'text', value: d.instruction, autocomplete: 'off' });
      const paintPlaceholders = () => {
        text.placeholder = d.op === 'draft' ? 'Paste what you are replying to, or leave this empty and describe the message below. Or drop a file here.' : 'Paste the text to put in your voice. Or drop a file here.';
        instr.placeholder = d.op === 'draft' ? 'What should it say? e.g. "decline, but offer next week"' : 'Anything else? e.g. "keep the second paragraph as it is"';
      };
      paintPlaceholders();
      acceptFilesInto(text, app);
      text.addEventListener('input', () => { d.input = text.value; save(); });
      instr.addEventListener('input', () => { d.instruction = instr.value; save(); });
      text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void run(); } });
      instr.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void run(); } });

      const go = el('button', { class: 'primary small wr-go', type: 'button', title: 'Run (⌘/Ctrl+Enter)', onclick: () => void run() }, 'Write in my voice');
      const stop = el('button', { class: 'ghost small', type: 'button', hidden: true, onclick: () => abort?.abort() }, 'Stop');
      const status = el('span', { class: 'muted wr-status' });
      const hint = d.profile ? null : el('p', { class: 'muted wr-hint' }, 'No voice yet, so the model writes in a neutral voice. ',
        el('button', { class: 'link-btn', type: 'button', onclick: () => { view = 'voice'; paint(); } }, 'Add a few samples of your writing'), ' and distill them once.');

      const outText = el('div', { class: 'wr-out-text' });
      const outMeta = el('span', { class: 'wr-out-meta' });
      const useBtn = el('button', { class: 'ghost small', type: 'button', title: 'Put this result in the box above and work on it again', onclick: () => {
        if (!d.output) return;
        text.value = d.output.text; d.input = text.value; writeNow(); text.focus();
      } }, 'Use as input');
      const fixBtn = el('button', { class: 'ghost small wr-not-me', type: 'button', title: 'Add a one-line correction that every run follows from now on', onclick: () => { focusAmend = true; view = 'voice'; paint(); } }, 'Not me?');
      const copyBtn = el('button', { class: 'ghost small wr-copy', type: 'button', onclick: async () => { await navigator.clipboard.writeText(d.output?.text ?? outText.textContent ?? ''); app.toast('Copied'); } }, 'Copy');
      const out = el('div', { class: 'wr-out', hidden: !d.output }, el('div', { class: 'wr-out-head' }, outMeta, el('span', { class: 'row-actions' }, fixBtn, useBtn, copyBtn)), outText);
      const showOutput = () => {
        if (!d.output) { out.hidden = true; return; }
        out.hidden = false; outText.textContent = d.output.text;
        outMeta.textContent = `In your voice · ${d.output.register} · ${d.output.op}${d.output.version ? ` · voice v${d.output.version}` : ' · no voice profile'} · ${d.output.model}`;
      };
      showOutput();
      pane.append(el('div', { class: 'wr-row' }, regSel, ops), text, instr);
      if (hint) pane.append(hint);
      pane.append(el('div', { class: 'wr-run' }, go, stop, status), out);

      async function run() {
        if (abort) return;
        const src = text.value.trim(); const ins = instr.value.trim();
        if (d.op !== 'draft' && !src) { app.toast('Paste or type the text first.'); text.focus(); return; }
        if (d.op === 'draft' && !src && !ins) { app.toast('A draft needs a brief: say what the message should do.'); instr.focus(); return; }
        const budget = TEXT_BUDGET[mode()];
        if (src.length > budget) { app.toast(isLocal() ? `The model on this device handles about ${words(budget).toLocaleString()} words at a time. Shorten the text, or pick a cloud model in the header.` : 'That is more text than one run can carry. Split it up.'); return; }
        const provider = await ready(); if (!provider) return;
        const reg = register(); const model = modelName(); const op = d.op;
        const messages = transformMessages({ profile: d.profile?.text ?? null, amendments: d.amendments.map((a) => a.text), register: reg, op, text: src, instruction: ins, profileChars: isLocal() ? LOCAL_PROFILE_CHARS : undefined });
        abort = new AbortController(); go.disabled = true; stop.hidden = false; status.textContent = 'Writing…';
        out.hidden = false; out.classList.add('streaming'); outText.textContent = '';
        outMeta.textContent = `${reg?.name ?? 'No register'} · ${op} · ${model}`;
        let raw = ''; let frame = 0; let tokens = 0; const t0 = performance.now();
        const paintOut = () => { frame = 0; outText.textContent = raw; };
        const keep = () => {
          d.output = { text: cleanOutput(raw, reg), op, register: reg?.name ?? 'no register', version: d.profile?.version ?? null, model, at: Date.now() };
          writeNow(); showOutput();
        };
        try {
          for await (const tok of provider.ask(messages, abort.signal, { maxTokens: OUTPUT_TOKENS[mode()] })) {
            tokens++; raw += tok; status.textContent = '';
            if (!frame) frame = requestAnimationFrame(paintOut);
          }
          if (frame) cancelAnimationFrame(frame);
          if (!raw.trim()) throw new Error('the model returned nothing');
          keep();
          const secs = (performance.now() - t0) / 1000;
          status.textContent = `${tokens} tokens · ${(tokens / Math.max(0.1, secs)).toFixed(1)} tok/s${wantsNoEmDash(reg) && /—/.test(raw) ? ' · em dashes removed, as the register asks' : ''}`;
        } catch (err) {
          if (frame) cancelAnimationFrame(frame); paintOut();
          if (abort.signal.aborted) { status.textContent = 'Stopped.'; if (raw.trim()) keep(); else showOutput(); }
          else { status.textContent = `Error: ${(err as Error).message}`; showOutput(); }
        } finally {
          out.classList.remove('streaming'); abort = null; go.disabled = false; stop.hidden = true;
        }
      }
    }

    // ---------- Voice: samples in, a profile out, corrections on top ----------
    function paintVoice() {
      const inUse = () => d.samples.filter((s) => s.use);
      const nextVersion = () => Math.max(d.profile?.version ?? 0, ...d.history.map((h) => h.version)) + 1;
      // Where a sample came from: the registers first, since that is what a sample teaches, then the usual places.
      const sourcesId = `wr-sources-${inst.id}`;
      const sources = el('datalist', { id: sourcesId });
      for (const n of [...new Set([...d.registers.map((r) => r.name.trim().toLowerCase()), 'email', 'slack', 'blog', 'doc'].filter(Boolean))]) sources.append(new Option(n));
      const sourceInput = (value = '') => {
        const i = el('input', { class: 'line-input wr-sample-source', type: 'text', value, placeholder: 'Where from? e.g. email, slack, blog', autocomplete: 'off' });
        i.setAttribute('list', sourcesId); // a read-only property, so the attribute
        return i;
      };

      const list = el('div', { class: 'wr-list' });
      const sampleRow = (s: Sample): HTMLElement => {
        const use = el('input', { type: 'checkbox', class: 'wr-use', checked: s.use, title: s.use ? 'Used when distilling. Uncheck to keep it without using it.' : 'Not used when distilling. Check to use it.', 'aria-label': 'Use when distilling' } as any);
        use.onchange = () => { s.use = use.checked; writeNow(); paintList(); paintDistill(); };
        const row = el('div', { class: `wr-item wr-sample${s.use ? '' : ' off'}` },
          el('span', { class: 't' }, use,
            el('button', { class: 'wr-open', type: 'button', title: 'Open to read or edit', onclick: () => openSample(s, row) }, el('span', { class: 'wr-tag' }, s.source || 'sample'), s.text.replace(/\s+/g, ' ').slice(0, 140))),
          el('span', { class: 'acts' },
            el('button', { class: 'ctl', type: 'button', title: 'Edit this sample', onclick: () => openSample(s, row) }, '✎'),
            el('button', { class: 'ctl', type: 'button', title: 'Remove this sample', onclick: () => {
              if (s.text.length > 400 && !confirm('Remove this sample? Its text goes with it.')) return;
              d.samples.splice(d.samples.indexOf(s), 1); writeNow(); paintList(); paintDistill();
            } }, '×')),
          el('span', { class: 'meta' }, `${countWords(s.text).toLocaleString()} words · ${s.editedAt ? `edited ${relTime(s.editedAt)}` : `added ${relTime(s.addedAt)}`}${s.use ? '' : ' · not used when distilling'}`));
        return row;
      };
      /** The whole sample, in place of its row: the text and where it came from, both editable. */
      const openSample = (s: Sample, row: HTMLElement) => {
        const ta = el('textarea', { class: 'wr-text wr-sample-edit', value: s.text, spellcheck: false });
        acceptFilesInto(ta, app);
        const src = sourceInput(s.source);
        const close = () => paintList();
        const saveIt = () => {
          let t = ta.value.trim();
          if (!t) { app.toast('A sample needs some text. Remove it instead if you are done with it.'); ta.focus(); return; }
          if (t.length > SAMPLE_MAX) { t = t.slice(0, SAMPLE_MAX); app.toast(`Kept the first ${SAMPLE_MAX.toLocaleString()} characters of that sample.`); }
          const source = src.value.trim().toLowerCase().slice(0, 24);
          if (t !== s.text || source !== s.source) { s.text = t; s.source = source; s.editedAt = Date.now(); writeNow(); }
          paintList(); paintDistill();
        };
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveIt(); } if (e.key === 'Escape') close(); });
        const ed = el('div', { class: 'wr-editor wr-sample-editor' },
          ta,
          el('div', { class: 'wr-row' }, src,
            el('span', { class: 'muted wr-count' }, `${countWords(s.text).toLocaleString()} words · added ${relTime(s.addedAt)}`),
            el('span', { class: 'row-actions' },
              el('button', { class: 'ghost small', type: 'button', onclick: close }, 'Cancel'),
              el('button', { class: 'primary small wr-save-sample', type: 'button', onclick: saveIt }, 'Save sample'))));
        ta.addEventListener('input', () => { (ed.querySelector('.wr-count') as HTMLElement).textContent = `${countWords(ta.value).toLocaleString()} words · added ${relTime(s.addedAt)}`; });
        row.replaceWith(ed); ta.focus();
      };
      const paintList = () => {
        clear(list);
        if (!d.samples.length) list.append(el('p', { class: 'muted empty' }, 'No samples yet. Paste three to five pieces of your real writing below: a couple of emails, a few chat messages, something longer if you have it.'));
        for (const s of d.samples) list.append(sampleRow(s));
      };
      paintList();
      const sampleText = el('textarea', { class: 'wr-text wr-sample-text', placeholder: 'Paste one piece of your writing, as you actually sent it. Or drop a file here.', spellcheck: false });
      acceptFilesInto(sampleText, app);
      const source = sourceInput();
      const add = () => {
        let t = sampleText.value.trim();
        if (!t) { app.toast('Paste some of your writing first.'); sampleText.focus(); return; }
        if (t.length > SAMPLE_MAX) { t = t.slice(0, SAMPLE_MAX); app.toast(`Kept the first ${SAMPLE_MAX.toLocaleString()} characters of that sample.`); }
        d.samples.push({ id: uid(), text: t, source: source.value.trim().toLowerCase().slice(0, 24), addedAt: Date.now(), editedAt: 0, use: true });
        sampleText.value = ''; writeNow(); paintList(); paintDistill(); sampleText.focus();
      };
      source.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      sampleText.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } });

      const distillBtn = el('button', { class: 'primary small wr-distill', type: 'button', onclick: () => void distill() }, 'Distill my voice');
      const stop = el('button', { class: 'ghost small', type: 'button', hidden: true, onclick: () => abort?.abort() }, 'Stop');
      // Three lines: whether the profile has fallen behind the samples, what pressing the button will send, and how the last press went.
      const staleNote = el('span', { class: 'wr-stale', hidden: true });
      const budgetNote = el('span', { class: 'muted wr-budget' });
      const note = el('span', { class: 'muted wr-status' });
      const paintDistill = () => {
        const using = inUse();
        distillBtn.disabled = !using.length || !!abort;
        distillBtn.textContent = d.profile ? `Distill again (v${nextVersion()})` : 'Distill my voice';
        const changed = samplesChangedSince(d.profile, d.samples);
        // Nothing new to learn from: the button steps back so it does not invite a pointless rebuild.
        distillBtn.classList.toggle('primary', !d.profile || !!changed);
        distillBtn.classList.toggle('ghost', !!d.profile && !changed);
        staleNote.hidden = !d.profile || !changed;
        if (d.profile && changed) staleNote.textContent = `${changed} change${changed === 1 ? '' : 's'} to your samples since v${d.profile.version}. Distill again to fold ${changed === 1 ? 'it' : 'them'} in; v${d.profile.version} is kept.`;
        const budget = SAMPLE_BUDGET[mode()];
        const used = samplesThatFit(using, budget);
        const off = d.samples.length - using.length;
        budgetNote.textContent = !using.length ? (d.samples.length ? 'Check at least one sample to distill from.' : '')
          : used < using.length ? `Uses the first ${used} of ${using.length} checked samples: the model on this device reads about ${words(budget).toLocaleString()} words at a time. Uncheck some to choose which, or pick a cloud model in the header to use them all.`
            : `Sends ${using.length} sample${using.length === 1 ? '' : 's'}${off ? ` (${off} unchecked)` : ''} to ${modelName()}, once.`;
      };
      paintDistill();
      pick.addEventListener('change', paintDistill);

      const profBox = el('details', { class: 'wr-profile', hidden: !d.profile, open: !!d.profile });
      const summary = el('summary', {});
      const profText = el('div', { class: 'wr-profile-text' });
      const profBody = el('div', { class: 'wr-profile-body' });
      const describe = (p: VoiceProfile) => `v${p.version} · from ${p.samples} sample${p.samples === 1 ? '' : 's'} · ${p.model}${p.edited ? ' · edited' : ''} · ${relTime(p.builtAt)}`;
      const paintSummary = () => {
        if (!d.profile) { profBox.hidden = true; return; }
        profBox.hidden = false;
        summary.textContent = `Voice profile ${describe(d.profile)}`;
        profText.textContent = d.profile.text;
      };
      const restore = (h: VoiceProfile) => {
        d.history.splice(d.history.indexOf(h), 1);
        if (d.profile) d.history.unshift(d.profile);
        d.profile = h; writeNow(); paintNav(); paintSummary(); paintProfileBody(); paintDistill();
        app.toast(`Back on voice v${h.version}.`);
      };
      const paintProfileBody = () => {
        clear(profBody);
        profBody.append(profText, el('div', { class: 'row-actions' },
          el('button', { class: 'ghost small', type: 'button', onclick: editProfile }, 'Edit'),
          el('button', { class: 'ghost small', type: 'button', onclick: async () => { await navigator.clipboard.writeText(d.profile?.text ?? ''); app.toast('Profile copied'); } }, 'Copy')));
        if (d.history.length) {
          profBody.append(el('div', { class: 'wr-history' },
            el('span', { class: 'wr-subhead' }, 'Earlier versions'),
            ...d.history.map((h) => el('div', { class: 'wr-item wr-version' },
              el('span', { class: 't', title: h.text.slice(0, 400) }, describe(h)),
              el('span', { class: 'acts' }, el('button', { class: 'ghost small', type: 'button', title: 'Write with this version again; the current one is kept', onclick: () => restore(h) }, 'Restore'))))));
        }
      };
      const editProfile = () => {
        const ta = el('textarea', { class: 'wr-text wr-profile-edit', value: d.profile?.text ?? '', spellcheck: false });
        clear(profBody);
        profBody.append(
          el('p', { class: 'muted' }, 'The profile is plain text and rides along on every run as written. Hand edits last until you distill again, and the version they are in is kept below then. For a fix that should outlast every distill, add a correction instead.'),
          ta,
          el('div', { class: 'row-actions' },
            el('button', { class: 'ghost small', type: 'button', onclick: paintProfileBody }, 'Cancel'),
            el('button', { class: 'primary small', type: 'button', onclick: () => {
              if (d.profile && ta.value.trim() && ta.value.trim() !== d.profile.text) { d.profile.text = ta.value.trim(); d.profile.edited = true; writeNow(); }
              paintSummary(); paintProfileBody();
            } }, 'Save profile')));
        ta.focus();
      };
      paintProfileBody(); paintSummary();
      profBox.append(summary, profBody);

      // ---- corrections: one line each, on every run, through every distill ----
      const amendList = el('div', { class: 'wr-list' });
      const amendInput = el('input', { class: 'line-input wr-amend-input', type: 'text', placeholder: 'e.g. I never say "reach out"; I sign emails with just "D"', autocomplete: 'off', maxlength: AMENDMENT_MAX } as any);
      const paintAmend = () => {
        clear(amendList);
        for (const a of d.amendments) {
          const row = el('div', { class: 'wr-item wr-amend' },
            el('span', { class: 't', title: a.text }, a.text),
            el('span', { class: 'acts' },
              el('button', { class: 'ctl', type: 'button', title: 'Edit', onclick: () => {
                const inp = el('input', { class: 'line-input', type: 'text', value: a.text, maxlength: AMENDMENT_MAX } as any);
                const done = (keep: boolean) => { if (keep && inp.value.trim()) { a.text = inp.value.trim(); writeNow(); } paintAmend(); };
                inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); });
                inp.addEventListener('blur', () => done(true));
                row.replaceWith(inp); inp.focus();
              } }, '✎'),
              el('button', { class: 'ctl', type: 'button', title: 'Remove', onclick: () => { d.amendments.splice(d.amendments.indexOf(a), 1); writeNow(); paintAmend(); } }, '×')),
            el('span', { class: 'meta' }, `added ${relTime(a.at)}`));
          amendList.append(row);
        }
      };
      const addAmend = () => {
        const t = amendInput.value.trim();
        if (!t) { amendInput.focus(); return; }
        if (d.amendments.length >= MAX_AMENDMENTS) { app.toast(`That is ${MAX_AMENDMENTS} corrections. Distill again so the profile takes them in, then remove a few.`); return; }
        d.amendments.push({ id: uid(), text: t.slice(0, AMENDMENT_MAX), at: Date.now() });
        amendInput.value = ''; writeNow(); paintAmend(); amendInput.focus();
      };
      amendInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAmend(); } });
      paintAmend();

      async function distill() {
        const using = inUse();
        if (abort || !using.length) return;
        const provider = await ready(); if (!provider) return;
        const m = mode();
        const { messages, used } = distillMessages(inst.config.author || 'You', using, SAMPLE_BUDGET[m], PROFILE_WORDS[m], d.amendments.map((a) => a.text));
        abort = new AbortController(); paintDistill(); stop.hidden = false; note.textContent = 'Reading your samples…';
        profBox.hidden = false; profBox.open = true; summary.textContent = 'Distilling…';
        clear(profBody); profBody.append(profText); profText.textContent = '';
        let raw = ''; let frame = 0;
        const paintRaw = () => { frame = 0; profText.textContent = raw; };
        try {
          for await (const tok of provider.ask(messages, abort.signal, { maxTokens: m === 'local' ? 700 : 1600 })) {
            raw += tok; note.textContent = '';
            if (!frame) frame = requestAnimationFrame(paintRaw);
          }
          if (frame) cancelAnimationFrame(frame);
          if (!raw.trim()) throw new Error('the model returned nothing');
          // The version this replaces is kept, hand edits and all.
          if (d.profile) d.history = [d.profile, ...d.history].slice(0, HISTORY_MAX);
          d.profile = { text: raw.trim(), version: nextVersion(), builtAt: Date.now(), samples: used, model: modelName(), basis: using.map((s) => s.id), edited: false };
          writeNow(); paintNav();
          note.textContent = `Voice v${d.profile.version} is ready. Every run now writes as you.`;
        } catch (err) {
          if (frame) cancelAnimationFrame(frame);
          note.textContent = abort.signal.aborted ? 'Stopped.' : `Distilling failed: ${(err as Error).message}`;
        } finally {
          abort = null; stop.hidden = true; paintSummary(); paintProfileBody(); paintDistill();
        }
      }

      pane.append(
        el('p', { class: 'muted' }, 'Your voice is distilled from samples of your real writing: what you actually sent, not what you wish you had. Three to five pieces across a couple of registers is plenty to start. Open any sample to fix or trim it. Samples stay in this browser and go to the model only when you distill.'),
        sources, list, sampleText,
        el('div', { class: 'wr-row' }, source, el('button', { class: 'ghost small wr-add-sample', type: 'button', onclick: add }, 'Add sample')),
        el('div', { class: 'wr-run' }, distillBtn, stop, note),
        staleNote, budgetNote,
        profBox,
        el('div', { class: 'wr-amends' },
          el('span', { class: 'wr-subhead' }, 'Corrections'),
          el('p', { class: 'muted' }, 'When a result is not you, say so here in one line. Every run follows these over the profile, and distilling again keeps them.'),
          amendList,
          el('div', { class: 'wr-row' }, amendInput, el('button', { class: 'ghost small wr-add-amend', type: 'button', onclick: addAmend }, 'Add correction'))),
      );
      if (focusAmend) { focusAmend = false; requestAnimationFrame(() => { amendInput.scrollIntoView({ block: 'center' }); amendInput.focus(); }); }
    }

    // ---------- Registers: one voice, several modes ----------
    function paintRegisters() {
      const list = el('div', { class: 'wr-list' });
      const editor = el('div', { class: 'wr-editor', hidden: true });
      const openEditor = (r: Register, isNew: boolean) => {
        clear(editor); editor.hidden = false;
        const name = el('input', { class: 'line-input wr-reg-name', type: 'text', value: r.name, placeholder: 'e.g. LinkedIn post', autocomplete: 'off' });
        const formality = el('input', { class: 'line-input wr-reg-formality', type: 'text', value: r.formality, placeholder: 'e.g. casual, conversational', autocomplete: 'off' });
        const length = el('input', { class: 'line-input wr-reg-length', type: 'text', value: r.length, placeholder: 'e.g. terse; one to three lines', autocomplete: 'off' });
        const notes = el('textarea', { class: 'line-input wr-reg-notes', value: r.notes, placeholder: 'e.g. no em dashes; lowercase is fine; sign off with my first name', rows: 3 });
        const saveBtn = el('button', { class: 'primary small', type: 'button', onclick: () => {
          const n = name.value.trim();
          if (!n) { app.toast('A register needs a name.'); name.focus(); return; }
          const saved: Register = { id: r.id, name: n.slice(0, 40), formality: formality.value.trim().slice(0, 200), length: length.value.trim().slice(0, 200), notes: notes.value.trim().slice(0, 1000) };
          const i = d.registers.findIndex((x) => x.id === saved.id);
          if (i >= 0) d.registers[i] = saved; else d.registers.push(saved);
          if (isNew) d.registerId = saved.id; // you added it to use it
          writeNow(); editor.hidden = true; paintList(); paintNav();
        } }, 'Save register');
        editor.append(
          el('div', { class: 'grid-2' }, field('Register', name), field('Formality', formality)),
          field('Length', length),
          field('Rules', notes, 'Followed exactly, punctuation and formatting included. “No em dashes” is also enforced after the model answers.'),
          el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', onclick: () => { editor.hidden = true; } }, 'Cancel'), saveBtn));
        name.focus();
      };
      const paintList = () => {
        clear(list);
        if (!d.registers.length) list.append(el('p', { class: 'muted empty' }, 'No registers. Every run uses the plain voice until you add one.'));
        for (const r of d.registers) {
          const summary = [r.length, r.notes].filter((s) => s.trim()).join(' · ');
          list.append(el('div', { class: 'wr-item wr-register-row' },
            el('span', { class: 't' }, el('strong', {}, r.name || 'Untitled'), r.id === d.registerId ? el('span', { class: 'wr-tag wr-inuse' }, 'in use') : '', r.formality ? el('span', { class: 'muted' }, ` · ${r.formality}`) : ''),
            el('span', { class: 'acts' },
              r.id === d.registerId ? '' : el('button', { class: 'ctl', type: 'button', title: 'Write in this register', onclick: () => { d.registerId = r.id; writeNow(); paintList(); } }, '✓'),
              el('button', { class: 'ctl', type: 'button', title: 'Edit', onclick: () => openEditor(r, false) }, '✎'),
              el('button', { class: 'ctl', type: 'button', title: 'Delete this register', onclick: () => {
                if (!confirm(`Delete the “${r.name}” register?`)) return;
                d.registers = d.registers.filter((x) => x !== r);
                if (d.registerId === r.id) d.registerId = d.registers[0]?.id ?? '';
                writeNow(); paintList(); paintNav();
              } }, '×')),
            el('span', { class: 'meta', title: summary }, summary || 'No length or rules yet')));
        }
      };
      paintList();
      pane.append(
        el('p', { class: 'muted' }, 'One voice, several registers: the same person at a different formality and length. Rules are followed exactly, so “no em dashes” means none, and “sign off with just my first name” means that. Pick the register in the Write view, or with the check here.'),
        list, editor,
        el('div', { class: 'row-actions' }, el('button', { class: 'ghost small wr-add-register', type: 'button', onclick: () => openEditor(newRegister(), true) }, 'Add register')),
      );
    }

    body.append(el('div', { class: 'wr' }, nav, pane,
      el('div', { class: 'wr-brand' }, 'Voice engine by ', el('a', { href: DICKENS_URL, target: '_blank', rel: 'noopener', title: 'Dickens: writing that sounds like you, by the same author' }, 'Dickens'))));
    paint();
    // Model profiles can change under us from a chat widget's settings; refresh the picker when this tab is looked at again.
    document.addEventListener('visibilitychange', async () => { if (!document.hidden && pick.isConnected) { profiles = await loadProfiles(); paintPick(); } });
  },
  configure(body, inst, ctx) {
    clear(body);
    const name = el('input', { class: 'line-input', type: 'text', value: inst.config.name ?? 'Writing' });
    const author = el('input', { class: 'line-input', type: 'text', value: inst.config.author ?? 'You', placeholder: 'You' });
    body.append(
      el('p', { class: 'muted' }, 'One widget is one voice. For someone else\'s, a client or a brand, add a second Writing widget and feed it their samples. The model comes from the header: the one on this device, the Settings endpoint, or any model added in an LLM Chat widget.'),
      setupForm([el('div', { class: 'grid-2' }, field('Title', name), field('Whose voice', author, 'Named in the profile: “You”, “Priya”, “the Acme brand”.'))], async () => {
        inst.config.name = name.value.trim() || 'Writing'; inst.config.author = author.value.trim() || 'You';
        await ctx.save(inst); ctx.remount(inst);
      }, () => ctx.remount(inst)),
      el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', onclick: async () => {
        if (!confirm('Forget this voice? The samples, the profile and its earlier versions, the corrections, and the registers go back to the defaults. This cannot be undone.')) return;
        await setItem(cacheKey(inst), null); ctx.remount(inst);
      } }, 'Forget this voice')),
    );
  },
};

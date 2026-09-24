import type { WidgetInstance } from '@/lib/layout';
import { clear, el } from '@/lib/dom';
import { getItem, setItem } from '@/lib/store';
import { ensureOriginPermission } from '@/lib/settings';
import { renderMarkdown } from '@/lib/markdown';
import type { Message } from '@/lib/llm/types';
import { PRESETS, choices, listModels, loadProfiles, newProfile, profileReady, providerFor, saveProfiles, type ChoiceId, type ModelProfile } from '@/lib/chat-models';
import { cacheKey, field, setupForm, type WidgetCtx, type WidgetDef } from './shared';

/**
 * LLM Chat: a conversation with whichever model you point it at. The model on this device, the cloud endpoint
 * from Settings, or any profile you add: Anthropic, OpenAI, OpenRouter, Gemini, Groq, Ollama, LM Studio, or
 * another OpenAI-compatible server. Keys stay in this browser and go only to their own endpoint. The
 * conversation is kept, so it is there on the next tab.
 */
interface ChatData { messages: Message[] }
const CHAT_SYSTEM = 'You are a helpful assistant in a chat panel on the user\'s new tab page. Answer directly and concretely. Use Markdown when it helps.';
const MAX_MESSAGES = 60; const MAX_CHARS = 30_000;

/** Which model a new chat starts with: the device model if it is set up, else the cloud endpoint, else the first profile. */
function defaultChoice(ctx: WidgetCtx, profiles: ModelProfile[]): ChoiceId {
  const list = choices(ctx.app, profiles);
  return (list.find((c) => c.ready) ?? list[0]!).id;
}

export const chat: WidgetDef = {
  type: 'chat', title: 'LLM Chat', description: 'Talk to any model: on this device, Claude, GPT, Ollama, or your own endpoint.', single: false, fill: true,
  defaultConfig: () => ({ name: 'Chat', model: '', system: '' }),
  name: (inst) => inst.config.name || 'Chat',
  async render(body, actions, inst, ctx) {
    const { app } = ctx;
    let profiles = await loadProfiles();
    const data = await getItem<ChatData | null>(cacheKey(inst), null) ?? { messages: [] };
    if (!Array.isArray(data.messages)) data.messages = [];
    const persist = () => {
      while (data.messages.length > MAX_MESSAGES || data.messages.reduce((n, m) => n + m.content.length, 0) > MAX_CHARS) data.messages.splice(0, 2);
      void setItem(cacheKey(inst), data);
    };

    // ---- model picker in the header ----
    const pick = el('select', { class: 'line-input chat-model', title: 'Which model answers' });
    const paintPick = () => {
      clear(pick);
      const list = choices(app, profiles);
      if (!inst.config.model || !list.some((c) => c.id === inst.config.model)) inst.config.model = defaultChoice(ctx, profiles);
      for (const c of list) pick.append(new Option(`${c.name}${c.ready ? '' : ' · not set up'}`, c.id, false, c.id === inst.config.model));
      pick.append(new Option('Add a model…', '__add__'));
    };
    pick.onchange = async () => {
      if (pick.value === '__add__') { chat.configure!(body, inst, ctx); return; }
      inst.config.model = pick.value; await ctx.save(inst);
    };
    app.onReadyChange(() => { if (pick.isConnected) paintPick(); });
    paintPick();
    const newBtn = el('button', { class: 'ghost small chat-new', type: 'button', onclick: () => { abort?.abort(); data.messages = []; persist(); paintLog(); input.focus(); } }, 'New chat');
    actions.append(pick, newBtn);

    // ---- the conversation ----
    const log = el('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' } as any);
    const empty = el('p', { class: 'muted empty chat-empty' }, 'Ask anything. Shift+Enter for a new line.');
    const bubble = (m: Message) => {
      const b = el('div', { class: 'bubble' });
      if (m.role === 'assistant') renderMarkdown(m.content, b); else b.textContent = m.content;
      const copy = el('button', { class: 'ctl copy', type: 'button', title: 'Copy', onclick: async () => { await navigator.clipboard.writeText(m.content); app.toast('Copied'); } }, '⎘');
      return el('div', { class: `msg ${m.role}` }, b, copy);
    };
    const paintLog = () => {
      clear(log); empty.hidden = data.messages.length > 0;
      for (const m of data.messages) log.append(bubble(m));
      log.scrollTop = log.scrollHeight;
    };

    // ---- composing ----
    const input = el('textarea', { class: 'chat-input', rows: 1, placeholder: 'Message…', 'aria-label': 'Message' } as any);
    const send = el('button', { class: 'send chat-send', type: 'button', title: 'Send (Enter)', 'aria-label': 'Send' } as any, '↑');
    const stop = el('button', { class: 'ghost small chat-stop', type: 'button', hidden: true, onclick: () => abort?.abort() }, 'Stop');
    const status = el('span', { class: 'muted chat-status' });
    let abort: AbortController | null = null;
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
    input.addEventListener('input', grow);

    const ask = async () => {
      const text = input.value.trim(); if (!text || abort) return;
      const id: ChoiceId = inst.config.model;
      const provider = providerFor(id, app, profiles);
      if (!provider) { app.toast(id === 'fogar-local' ? 'Pick a model in Settings first.' : 'That model is not set up. Open the widget settings.'); return; }
      if (id === 'fogar-local') {
        if (app.isBusy()) { app.toast('The device model is busy answering the ask bar. Wait a moment or pick another model.'); return; }
        if (!app.local.loaded && !(await app.ensureModel())) { app.toast('Load the device model in Settings first.'); return; }
      }
      input.value = ''; grow();
      data.messages.push({ role: 'user', content: text }); persist();
      paintLog();
      const reply: Message = { role: 'assistant', content: '' };
      const node = bubble(reply); node.classList.add('streaming'); log.append(node);
      const target = node.querySelector<HTMLElement>('.bubble')!;
      abort = new AbortController();
      stop.hidden = false; send.disabled = true; status.textContent = 'Thinking…';
      const t0 = performance.now(); let tokens = 0; let frame = 0;
      const paint = () => { frame = 0; renderMarkdown(reply.content, target); log.scrollTop = log.scrollHeight; };
      try {
        const messages: Message[] = [{ role: 'system', content: (inst.config.system as string)?.trim() || CHAT_SYSTEM }, ...data.messages];
        for await (const tok of provider.ask(messages, abort.signal)) {
          tokens++; reply.content += tok; status.textContent = '';
          if (!frame) frame = requestAnimationFrame(paint);
        }
        if (frame) cancelAnimationFrame(frame); paint();
        const secs = (performance.now() - t0) / 1000;
        status.textContent = `${tokens} tokens · ${(tokens / Math.max(0.1, secs)).toFixed(1)} tok/s`;
      } catch (err) {
        if (frame) cancelAnimationFrame(frame); paint();
        if (abort.signal.aborted) status.textContent = 'Stopped.';
        else { target.append(el('p', { class: 'warn' }, `Error: ${(err as Error).message}`)); status.textContent = ''; }
      } finally {
        node.classList.remove('streaming');
        if (reply.content.trim()) { data.messages.push(reply); persist(); }
        else if (!abort.signal.aborted) data.messages.pop(); // nothing came back: do not leave a dangling question in the history
        abort = null; stop.hidden = true; send.disabled = false;
        paintLog(); input.focus();
      }
    };
    send.onclick = () => void ask();
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } });

    body.append(el('div', { class: 'chat' }, log, empty, el('div', { class: 'chat-compose' }, input, stop, send), status));
    paintLog();
    // Profiles can change under us from another chat widget's settings; refresh the picker when this tab is looked at again.
    document.addEventListener('visibilitychange', async () => { if (!document.hidden && pick.isConnected) { profiles = await loadProfiles(); paintPick(); } });
  },
  configure(body, inst, ctx) {
    clear(body);
    const name = el('input', { class: 'line-input', type: 'text', value: inst.config.name ?? 'Chat' });
    const system = el('textarea', { class: 'line-input', value: inst.config.system ?? '', placeholder: CHAT_SYSTEM, rows: 3 });
    const list = el('div', { class: 'profiles' });
    const editor = el('div', { class: 'profile-editor', hidden: true });
    let profiles: ModelProfile[] = [];

    const openEditor = (p: ModelProfile, isNew: boolean) => {
      clear(editor); editor.hidden = false;
      const pname = el('input', { class: 'line-input', type: 'text', value: p.name });
      const endpoint = el('input', { class: 'line-input', type: 'url', value: p.endpoint, placeholder: p.kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1' });
      const key = el('input', { class: 'line-input', type: 'password', value: p.apiKey, autocomplete: 'off', placeholder: /localhost|127\.0\.0\.1/.test(p.endpoint) ? 'Not needed on this computer' : 'Your key, stored only in this browser' });
      const model = el('input', { class: 'line-input', type: 'text', value: p.model, autocomplete: 'off' });
      model.setAttribute('list', `models-${inst.id}`); // input.list is a read-only getter, so the helper cannot set it
      const datalist = el('datalist', { id: `models-${inst.id}` });
      const vision = el('input', { type: 'checkbox', checked: !!p.vision });
      const fetchNote = el('span', { class: 'muted' });
      const fetchBtn = el('button', { class: 'ghost small', type: 'button', onclick: async () => {
        fetchBtn.disabled = true; fetchNote.textContent = 'Asking…';
        try {
          await ensureOriginPermission(endpoint.value.trim());
          const ids = await listModels({ ...p, endpoint: endpoint.value.trim(), apiKey: key.value.trim() });
          clear(datalist); for (const id of ids) datalist.append(new Option(id, id));
          fetchNote.textContent = ids.length ? `${ids.length} models; start typing to pick one.` : 'The endpoint listed no models.';
          if (!model.value && ids.length) model.value = ids[0]!;
        } catch (err) { fetchNote.textContent = (err as Error).message; }
        finally { fetchBtn.disabled = false; }
      } }, 'Fetch models');
      editor.append(
        el('div', { class: 'grid-2' }, field('Name', pname), field('API endpoint', endpoint)),
        el('div', { class: 'grid-2' }, field('API key', key), field('Model', el('span', { class: 'model-row' }, model, datalist, fetchBtn))),
        el('div', { class: 'row-actions' }, el('label', { class: 'toggle' }, vision, ' This model reads images (lets the Notebook read photos with it)'), fetchNote),
        el('div', { class: 'row-actions' },
          el('button', { class: 'ghost small', type: 'button', onclick: () => { editor.hidden = true; } }, 'Cancel'),
          el('button', { class: 'primary small', type: 'button', onclick: async () => {
            p.name = pname.value.trim() || p.name; p.endpoint = endpoint.value.trim().replace(/\/+$/, ''); p.apiKey = key.value.trim(); p.model = model.value.trim(); p.vision = vision.checked;
            if (!p.endpoint || !p.model) { ctx.app.toast('An endpoint and a model name are needed.'); return; }
            try { new URL(p.endpoint); } catch { ctx.app.toast('That endpoint is not a URL.'); return; }
            const ok = await ensureOriginPermission(p.endpoint);
            if (isNew) profiles.push(p);
            await saveProfiles(profiles); editor.hidden = true; paintList();
            if (!inst.config.model || inst.config.model === '__add__') { inst.config.model = p.id; await ctx.save(inst); }
            ctx.app.toast(ok ? 'Model saved' : 'Saved, but permission for that endpoint was not granted.');
          } }, 'Save model')),
      );
      pname.focus();
    };
    const paintList = () => {
      clear(list);
      if (!profiles.length) list.append(el('p', { class: 'muted empty' }, 'No models added yet. The device model and the Settings cloud endpoint are always available.'));
      for (const p of profiles) {
        list.append(el('div', { class: 'profile-row' },
          el('span', { class: 'profile-name' }, el('strong', {}, p.name), el('span', { class: 'muted' }, ` · ${p.model || 'no model'} · ${(() => { try { return new URL(p.endpoint).host; } catch { return p.endpoint; } })()}${profileReady(p) ? '' : ' · needs a key'}`)),
          el('span', { class: 'row-actions' },
            el('button', { class: 'ctl', type: 'button', title: 'Edit', onclick: () => openEditor(p, false) }, '✎'),
            el('button', { class: 'ctl', type: 'button', title: 'Remove', onclick: async () => { if (!confirm(`Remove “${p.name}”?`)) return; profiles = profiles.filter((x) => x !== p); await saveProfiles(profiles); paintList(); } }, '×'))));
      }
    };
    const preset = el('select', { class: 'line-input' });
    for (const p of PRESETS) preset.append(new Option(p.name, p.id));
    const addBtn = el('button', { class: 'ghost small', type: 'button', onclick: () => { const pr = PRESETS.find((x) => x.id === preset.value)!; openEditor(newProfile(pr), true); } }, 'Add');
    void loadProfiles().then((p) => { profiles = p; paintList(); });
    body.append(
      el('div', { class: 'grid-2' }, field('Title', name)),
      field('Instructions for the model (optional)', system),
      el('div', { class: 'row-head' }, el('span', { class: 'hint' }, 'Models this chat can use. Keys stay in this browser and are sent only to their own endpoint.'), el('span', { class: 'row-actions' }, preset, addBtn)),
      list, editor,
      setupForm([], async () => { inst.config.name = name.value.trim() || 'Chat'; inst.config.system = system.value; await ctx.save(inst); ctx.remount(inst); }, () => ctx.remount(inst), 'Done'),
    );
  },
};

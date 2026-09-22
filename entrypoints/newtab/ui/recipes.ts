import type { App } from '../app';
import { $, clear, el } from '@/lib/dom';
import { SYSTEM_PROMPT } from '@/lib/llm/types';
import {
  BUILTIN_RECIPES, allRecipes, decodeRecipeShare, encodeRecipeShare, loadUserRecipes, newRecipe, recipeMessages,
  parseRecipeText, saveUserRecipes, validateRecipe, type Recipe, type RecipeInput,
} from '@/lib/recipes';

export interface RecipesUI {
  runBuiltin(id: string, values: Record<string, string>): Promise<void>;
  offerShared(encoded: string): void;
  /** Open a recipe's form by id and scroll to it. */
  open(id: string): Promise<void>;
  /** A run form without the panel chrome, for the recipe widget. Output still goes to the conversation. */
  buildRunForm(recipe: Recipe, prefill?: Record<string, string>): HTMLElement;
}

export function initRecipes(app: App): RecipesUI {
  const chips = $('recipe-chips');
  const panel = $('recipe-panel');
  let active: string | null = null;

  const close = () => { active = null; panel.hidden = true; clear(panel); void renderChips(); };

  async function renderChips() {
    clear(chips);
    for (const r of await allRecipes()) {
      chips.append(el('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(active === r.id),
        onclick: () => { void app.ensureModel(); if (active === r.id) close(); else void openRun(r); },
      } as any, el('span', {}, r.emoji ?? '🧪'), r.name));
    }
  }

  function inputField(i: RecipeInput, value?: string): { node: HTMLElement; read: () => string } {
    let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (i.type === 'select') {
      control = el('select', {});
      for (const o of i.options ?? []) control.append(new Option(o, o, false, o === (value ?? i.default)));
    } else if (i.type === 'textarea') {
      control = el('textarea', { placeholder: i.placeholder ?? '', value: value ?? i.default ?? '' });
    } else {
      control = el('input', { type: 'text', placeholder: i.placeholder ?? '', value: value ?? i.default ?? '' });
    }
    control.dataset.key = i.key;
    return { node: el('label', { class: 'field' }, i.label, control), read: () => control.value };
  }

  function buildRunForm(recipe: Recipe, prefill: Record<string, string> = {}): HTMLElement {
    const fields = recipe.inputs.map((i) => inputField(i, prefill[i.key]));
    const values = () => Object.fromEntries(fields.map((f, idx) => [recipe.inputs[idx]!.key, f.read()]));
    const run = el('button', { class: 'primary', type: 'button', disabled: !app.canAnswer(), onclick: () => void app.ask(recipeMessages(recipe, values(), SYSTEM_PROMPT), { label: recipe.name }) }, 'Run');
    const hint = el('span', { class: 'hint' }, app.canAnswer() ? '' : 'Load a model or set a cloud endpoint to run recipes.');
    app.onReadyChange(() => { run.disabled = !app.canAnswer(); hint.textContent = app.canAnswer() ? '' : 'Load a model or set a cloud endpoint to run recipes.'; });
    const textareas = fields.filter((_, idx) => recipe.inputs[idx]!.type === 'textarea').map((f) => f.node);
    const others = fields.filter((_, idx) => recipe.inputs[idx]!.type !== 'textarea').map((f) => f.node);
    const form = el('div', { class: 'recipe-run' }, ...textareas);
    if (others.length) form.append(el('div', { class: 'grid-2' }, ...others));
    form.append(el('div', { class: 'row-actions' }, run, hint));
    return form;
  }

  async function openRun(recipe: Recipe, prefill: Record<string, string> = {}) {
    active = recipe.id;
    await renderChips();
    clear(panel); panel.hidden = false;
    const actions: HTMLElement[] = [];
    if (!recipe.builtin) {
      actions.push(el('button', { class: 'ghost small', type: 'button', onclick: () => void openEditor(recipe) }, 'Edit'));
      actions.push(el('button', { class: 'ghost small', type: 'button', onclick: async () => {
        if (!confirm(`Delete recipe “${recipe.name}”?`)) return;
        await saveUserRecipes((await loadUserRecipes()).filter((r) => r.id !== recipe.id)); close();
      } }, 'Delete'));
    }
    actions.push(el('button', { class: 'ghost small', type: 'button', onclick: async () => {
      const link = `${location.origin}/newtab.html?recipe=${encodeRecipeShare(recipe)}`;
      await navigator.clipboard.writeText(link);
      app.toast('Share link copied. It opens in any browser with Fogar installed.');
    } }, 'Share'));
    actions.push(el('button', { class: 'ghost small', type: 'button', onclick: async () => {
      const { builtin, ...rest } = recipe;
      await navigator.clipboard.writeText(JSON.stringify(rest, null, 2)); app.toast('Recipe JSON copied');
    } }, 'Copy JSON'));
    actions.push(el('button', { class: 'ghost small', type: 'button', onclick: close }, 'Close'));

    const form = buildRunForm(recipe, prefill);
    panel.append(
      el('div', { class: 'recipe-head' },
        el('div', {}, el('h3', {}, `${recipe.emoji ?? ''} ${recipe.name}`.trim()), el('p', { class: 'muted' }, recipe.description)),
        el('span', { class: 'row-actions' }, ...actions)),
      form,
    );
    (form.querySelector('textarea') as HTMLTextAreaElement | null)?.focus();
  }

  async function openEditor(recipe: Recipe) {
    active = recipe.id;
    await renderChips();
    clear(panel); panel.hidden = false;
    const name = el('input', { type: 'text', value: recipe.name, placeholder: 'Name' });
    const emoji = el('input', { type: 'text', value: recipe.emoji ?? '🧪', maxLength: 4, style: 'width:64px' });
    const description = el('input', { type: 'text', value: recipe.description, placeholder: 'What it does, in one line' });
    const system = el('textarea', { value: recipe.system ?? '', placeholder: 'Optional. How the model should behave, e.g. "Return only the rewritten text."' });
    const template = el('textarea', { value: recipe.template, placeholder: 'The prompt. Use {{key}} where an input goes.' });
    const rows = el('div', { style: 'display:grid;gap:8px' });
    const inputs: RecipeInput[] = recipe.inputs.map((i) => ({ ...i }));

    const renderRows = () => {
      clear(rows);
      inputs.forEach((i, idx) => {
        const key = el('input', { type: 'text', value: i.key, placeholder: 'key', oninput: () => { i.key = key.value.replace(/[^a-zA-Z0-9_]/g, ''); } });
        const label = el('input', { type: 'text', value: i.label, placeholder: 'Label', oninput: () => { i.label = label.value; } });
        const type = el('select', { onchange: () => { i.type = type.value as RecipeInput['type']; renderRows(); } });
        for (const t of ['text', 'textarea', 'select']) type.append(new Option(t, t, false, t === i.type));
        const options = el('input', { type: 'text', value: (i.options ?? []).join(', '), placeholder: 'Options, comma separated', disabled: i.type !== 'select', oninput: () => { i.options = options.value.split(',').map((s) => s.trim()).filter(Boolean); } });
        rows.append(el('div', { class: 'input-row' },
          el('label', { class: 'field' }, 'Key', key), el('label', { class: 'field' }, 'Label', label),
          el('label', { class: 'field' }, 'Type', type), el('label', { class: 'field' }, 'Options', options),
          el('button', { class: 'ghost small', type: 'button', onclick: () => { inputs.splice(idx, 1); renderRows(); } }, '×')));
      });
    };
    renderRows();

    const save = async () => {
      const candidate = validateRecipe({ ...recipe, name: name.value.trim(), emoji: emoji.value.trim(), description: description.value.trim(), system: system.value, template: template.value, inputs });
      if (!candidate) { app.toast('A recipe needs a name, a template with {{placeholders}}, and input keys made of letters, digits, or underscores.'); return; }
      const user = await loadUserRecipes();
      const idx = user.findIndex((r) => r.id === candidate.id);
      if (idx >= 0) user[idx] = candidate; else user.push(candidate);
      await saveUserRecipes(user);
      app.toast('Recipe saved');
      void openRun(candidate);
    };

    panel.append(
      el('div', { class: 'recipe-head' }, el('h3', {}, recipe.name ? `Edit “${recipe.name}”` : 'New recipe'),
        el('span', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', onclick: close }, 'Cancel'))),
      el('div', { class: 'grid-2' }, el('label', { class: 'field' }, 'Emoji', emoji), el('label', { class: 'field' }, 'Name', name)),
      el('label', { class: 'field' }, 'Description', description),
      el('div', {}, el('div', { class: 'row-head' }, el('span', { class: 'hint' }, 'Inputs. Each becomes a field in the form and a ', el('code', {}, '{{key}}'), ' you can use below.'),
        el('button', { class: 'ghost small', type: 'button', onclick: () => { inputs.push({ key: `input${inputs.length + 1}`, label: '', type: 'text' }); renderRows(); } }, 'Add input')), rows),
      el('label', { class: 'field' }, 'Prompt template', template),
      el('label', { class: 'field' }, 'System prompt (optional)', system),
      el('div', { class: 'row-actions' }, el('button', { class: 'primary', type: 'button', onclick: () => void save() }, 'Save recipe')),
    );
    name.focus();
  }

  function openImport() {
    active = '__import__'; void renderChips();
    clear(panel); panel.hidden = false;
    const box = el('textarea', { placeholder: 'Paste recipe JSON here' });
    panel.append(
      el('div', { class: 'recipe-head' }, el('h3', {}, 'Import a recipe'), el('span', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', onclick: close }, 'Cancel'))),
      el('label', { class: 'field' }, 'Recipe JSON', box),
      el('p', { class: 'hint' }, 'JSON with at least a ', el('code', {}, '"name"'), ' and a ', el('code', {}, '"template"'), '. A share link or its token works too. Labels and input types are filled in when missing.'),
      el('div', { class: 'row-actions' }, el('button', { class: 'primary', type: 'button', onclick: async () => {
        const { recipe, error } = parseRecipeText(box.value);
        if (!recipe) { app.toast(error ?? 'That is not a valid recipe.'); return; }
        await addShared(recipe);
      } }, 'Add recipe')),
    );
    box.focus();
  }

  async function addShared(recipe: Recipe) {
    const user = await loadUserRecipes();
    const clash = [...BUILTIN_RECIPES, ...user].some((r) => r.id === recipe.id);
    const toSave = clash ? { ...recipe, id: `${recipe.id}-${Date.now().toString(36)}` } : recipe;
    user.push(toSave);
    await saveUserRecipes(user);
    app.toast(`Added “${toSave.name}”`);
    void openRun(toSave);
  }

  $('recipe-new').onclick = () => void openEditor(newRecipe());
  $('recipe-import').onclick = openImport;
  $('export-btn').onclick = async () => {
    await navigator.clipboard.writeText(JSON.stringify(await loadUserRecipes(), null, 2));
    app.toast('Your recipes were copied as JSON');
  };
  void renderChips();

  return {
    buildRunForm,
    async open(id) {
      const r = (await allRecipes()).find((x) => x.id === id);
      if (!r) return;
      await openRun(r);
      panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    async runBuiltin(id, values) {
      const r = BUILTIN_RECIPES.find((x) => x.id === id);
      if (!r) return;
      await openRun(r, values);
      await app.ask(recipeMessages(r, values, SYSTEM_PROMPT), { label: r.name });
    },
    offerShared(encoded) {
      const recipe = decodeRecipeShare(encoded);
      if (!recipe) { app.toast('That share link is not a valid recipe.'); return; }
      active = '__shared__'; void renderChips();
      clear(panel); panel.hidden = false;
      panel.append(
        el('div', { class: 'recipe-head' }, el('div', {}, el('h3', {}, `Add “${recipe.emoji ?? ''} ${recipe.name}”?`.replace('“ ', '“')), el('p', { class: 'muted' }, recipe.description || 'Someone shared this recipe with you.')),
          el('span', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', onclick: close }, 'No thanks'))),
        el('p', { class: 'hint' }, 'Inputs: ', recipe.inputs.map((i) => i.label).join(', ') || 'none'),
        el('pre', { class: 'hint', style: 'white-space:pre-wrap;margin:0' }, recipe.template),
        el('div', { class: 'row-actions' }, el('button', { class: 'primary', type: 'button', onclick: () => void addShared(recipe) }, 'Add recipe')),
      );
      panel.scrollIntoView({ block: 'center' });
    },
  };
}

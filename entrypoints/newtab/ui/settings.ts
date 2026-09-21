import type { App } from '../app';
import { $ } from '@/lib/dom';
import { LocalProvider } from '@/lib/llm/local';
import { MODELS, modelById } from '@/lib/llm/models';
import { groundingApiUrl } from '@/lib/grounding';
import type { GroundingProvider } from '@/lib/llm/types';
import { ensureOriginPermission } from '@/lib/settings';
import { fmtBytes, el, clear } from '@/lib/dom';
import { installLedger, ledgerSnapshot, ledgerTotal, onLedgerChange } from '@/lib/ledger';
import { downloadJson, exportBackup, importBackup } from '@/lib/backup';

export function initSettings(app: App): void {
  const s = app.settings;

  // Local model
  const modelSel = $<HTMLSelectElement>('model');
  for (const m of MODELS) if (m.id !== 'smoke' || location.search.includes('smoke=1')) modelSel.add(new Option(`${m.label} · ${m.approxMB >= 1000 ? `${(m.approxMB / 1000).toFixed(1)} GB` : `${m.approxMB} MB`}${app.recommended?.id === m.id ? ' · recommended for this machine' : ''}`, m.id));
  modelSel.value = s.modelId;
  $('model-note').textContent = modelById(s.modelId).note;
  modelSel.onchange = () => { s.modelId = modelSel.value; $('model-note').textContent = modelById(s.modelId).note; void app.save(); };
  const gpu = $<HTMLInputElement>('gpu');
  gpu.checked = s.gpu; gpu.disabled = !LocalProvider.hasWebGPU();
  $('gpu-note').textContent = LocalProvider.hasWebGPU() ? '' : '(not available in this browser)';
  gpu.onchange = () => { s.gpu = gpu.checked; void app.save(); };
  $('load-btn').onclick = () => void app.loadModel();

  const refreshCache = async () => {
    const bytes = await LocalProvider.cacheSize();
    $('cache-line').textContent = bytes ? `Cached models: ${fmtBytes(bytes)}` : 'Cached models: none';
  };
  $('clear-cache').onclick = async (e) => {
    e.preventDefault();
    if (!confirm('Delete all downloaded models from this browser?')) return;
    await app.local.unload();
    await LocalProvider.clearCache();
    s.autoLoad = false; await app.save();
    await refreshCache(); app.refreshReadiness();
  };
  void refreshCache();
  app.onReadyChange(() => void refreshCache());

  // Cloud
  const endpoint = $<HTMLInputElement>('cloud-endpoint'); const key = $<HTMLInputElement>('cloud-key'); const model = $<HTMLInputElement>('cloud-model');
  endpoint.value = s.cloud.endpoint; key.value = s.cloud.apiKey; model.value = s.cloud.model;
  $('cloud-save').onclick = async () => {
    s.cloud = { endpoint: endpoint.value.trim(), apiKey: key.value.trim(), model: model.value.trim() };
    const ok = await ensureOriginPermission(s.cloud.endpoint);
    await app.save();
    app.setMode('cloud');
    app.toast(ok ? 'Cloud endpoint saved' : 'Saved, but permission for that endpoint was not granted.');
  };

  // Grounding
  const gProv = $<HTMLSelectElement>('ground-provider'); const gKey = $<HTMLInputElement>('ground-key'); const gDefault = $<HTMLInputElement>('ground-default');
  gProv.value = s.grounding.provider; gKey.value = s.grounding.apiKey; gDefault.checked = s.grounding.byDefault;
  $('ground-save').onclick = async () => {
    s.grounding = { ...s.grounding, provider: gProv.value as GroundingProvider, apiKey: gKey.value.trim(), byDefault: gDefault.checked };
    let note = 'Saved.';
    if (s.grounding.provider !== 'none') {
      const ok = await ensureOriginPermission(groundingApiUrl(s.grounding));
      note = ok ? 'Saved. Tick “Search the web first” under the ask box to use it.' : 'Saved, but permission for the search API was not granted.';
    }
    await app.save();
    $<HTMLInputElement>('ground').checked = s.grounding.byDefault;
    $('ground-note').textContent = note;
    app.refreshReadiness();
  };

  // Network ledger
  installLedger();
  const paintLedger = () => {
    const total = ledgerTotal();
    const pill = $('ledger-pill');
    pill.textContent = `network: ${total} request${total === 1 ? '' : 's'}`;
    pill.classList.toggle('busy', total > 0);
    const list = $('ledger-list'); clear(list);
    const rows = ledgerSnapshot();
    if (!rows.length) list.append(el('li', { class: 'muted' }, 'No requests yet.'));
    for (const r of rows) list.append(el('li', {}, el('span', {}, r.host), el('span', { class: 'muted' }, `${r.count} request${r.count === 1 ? '' : 's'}${r.bytes ? ` · ${fmtBytes(r.bytes)}` : ''}`)));
  };
  onLedgerChange(paintLedger); paintLedger();
  $('ledger-pill').onclick = () => { $<HTMLDetailsElement>('settings').open = true; };

  // Backup and restore
  $('backup-btn').onclick = async () => { downloadJson(`fogar-backup-${new Date().toISOString().slice(0, 10)}.json`, await exportBackup()); app.toast('Backup downloaded'); };
  const file = $<HTMLInputElement>('restore-file');
  $('restore-btn').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0]; if (!f) return;
    try {
      const result = await importBackup(JSON.parse(await f.text()));
      app.toast(`Restored ${result.recipes} recipes, ${result.todos} todos, ${result.reminders} reminders. Reloading…`);
      setTimeout(() => location.reload(), 900);
    } catch (err) { app.toast((err as Error).message); }
    file.value = '';
  };

  // Mode toggle
  $('mode-local').onclick = () => app.setMode('local');
  $('mode-cloud').onclick = () => app.setMode('cloud');
}

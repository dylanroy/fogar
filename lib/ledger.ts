/**
 * The network ledger: every request this page made, counted by host, straight from the browser's own
 * resource timeline. Nothing is inferred and nothing is hidden. Extension-internal URLs are not network.
 */
export interface LedgerEntry { host: string; count: number; bytes: number }

const counts = new Map<string, LedgerEntry>();
const listeners = new Set<() => void>();
let installed = false;

export function installLedger(): void {
  if (installed || typeof PerformanceObserver === 'undefined') return;
  installed = true;
  const record = (e: PerformanceEntry) => {
    try {
      const u = new URL(e.name, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      const entry = counts.get(u.host) ?? { host: u.host, count: 0, bytes: 0 };
      entry.count++;
      entry.bytes += (e as PerformanceResourceTiming).transferSize || 0;
      counts.set(u.host, entry);
    } catch { /* not a URL */ }
  };
  const po = new PerformanceObserver((list) => { list.getEntries().forEach(record); for (const cb of listeners) cb(); });
  po.observe({ type: 'resource', buffered: true });
}

export function ledgerSnapshot(): LedgerEntry[] {
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

export const ledgerTotal = (): number => [...counts.values()].reduce((n, e) => n + e.count, 0);

export function onLedgerChange(cb: () => void): void { listeners.add(cb); }

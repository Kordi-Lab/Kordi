/** React development tracks can retain serialized props in the User Timing buffer. */
export function installReactPerformanceRetention({
  timeline = globalThis.performance,
  Observer = globalThis.PerformanceObserver,
  retainHistory = false,
}: {
  timeline?: Pick<Performance, 'clearMeasures'>;
  Observer?: typeof PerformanceObserver;
  retainHistory?: boolean;
} = {}) {
  if (retainHistory || !timeline || typeof Observer !== 'function') return () => {};
  const observer = new Observer((list) => {
    const names = new Set<string>();
    for (const entry of list.getEntries()) {
      if (entry.entryType !== 'measure') continue;
      // React prefixes component entries; avoid deserializing large prop details
      // when draining a long-lived development window's existing backlog.
      if (entry.name.startsWith('\u200b')) { names.add(entry.name); continue; }
      const detail: unknown = (entry as PerformanceMeasure).detail;
      if (!detail || typeof detail !== 'object') continue;
      const rawTracks = (detail as { devtools?: unknown }).devtools;
      if (!rawTracks || typeof rawTracks !== 'object') continue;
      const tracks = rawTracks as { track?: unknown; trackGroup?: unknown };
      if (tracks.track === 'Components ⚛' || tracks.trackGroup === 'Scheduler ⚛') names.add(entry.name);
    }
    // Other observers and DevTools receive the emitted entries. Only the
    // persistent in-page history is removed; never retain props in our own buffer.
    for (const name of names) timeline.clearMeasures(name);
  });
  try { observer.observe({ type: 'measure', buffered: true }); }
  catch { observer.disconnect(); }
  return () => observer.disconnect();
}

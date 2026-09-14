import { invoke } from '@tauri-apps/api/core';

/** Local QA opt-in. Numeric geometry and anonymous DOM identities only. */
export async function installTranscriptTrajectoryRecorder() {
  if (!await invoke<boolean>('desktop_transcript_trace', { frames: [] }).catch(() => false)) return;
  const documentStartedAt = Date.now();
  const identities = new WeakMap<Element, number>();
  let nextIdentity = 1;
  const identity = (node: Element | null) => {
    if (!node) return 0;
    let id = identities.get(node);
    if (!id) { id = nextIdentity++; identities.set(node, id); }
    return id;
  };
  const round = (value: number) => Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
  const geometry = (node: Element | null) => {
    const box = node?.getBoundingClientRect();
    return [identity(node), box?.top ?? 0, box?.left ?? 0, box?.width ?? 0, box?.height ?? 0, node ? Number.parseFloat(getComputedStyle(node).opacity) : 0];
  };
  const states = ['starting', 'queued', 'processing', 'preparing', 'streaming', 'thinking', 'tooling', 'writing', 'finalizing', 'complete', 'failed', 'cancelled'];
  const previous = new WeakMap<Element, { value: string; at: number }>();
  let frames: number[][] = [];
  let enabled = true;
  let writes = Promise.resolve();
  const flush = () => {
    if (!frames.length) return;
    const batch = frames; frames = [];
    writes = writes.then(async () => {
      if (enabled) enabled = await invoke<boolean>('desktop_transcript_trace', { frames: batch }).catch(() => false);
    });
  };
  const end = performance.now() + 10 * 60_000;
  let flushedAt = performance.now();
  const sample = () => {
    if (!enabled || performance.now() > end) { flush(); return; }
    const at = Date.now();
    const shell = document.querySelector('.app-shell');
    for (const viewport of document.querySelectorAll<HTMLElement>('[data-virtual-transcript-scroll]')) {
      const rect = viewport.getBoundingClientRect();
      const pane = viewport.closest('.app-chat-pane-layout');
      const rows = [...viewport.querySelectorAll<HTMLElement>('[data-transcript-window-item]')].slice(0, 100);
      const cards = viewport.querySelectorAll<HTMLElement>('[data-live-turn-status]');
      const latest = cards.item(cards.length - 1);
      const frame = [1, documentStartedAt, identity(viewport), identity(shell), window.innerWidth, window.innerHeight,
        window.scrollY, rect.top, rect.left, rect.width, rect.height, viewport.scrollTop, viewport.scrollHeight,
        viewport.querySelector('[data-virtual-transcript-session-ready="true"]') ? 1 : 0,
        viewport.querySelectorAll('.app-agent-waiting-wave').length,
        viewport.querySelectorAll('.app-transcript-tool-timeline').length,
        states.indexOf(latest?.dataset.liveTurnStatus ?? ''), rows.length,
        ...rows.flatMap(row => {
          const box = row.getBoundingClientRect();
          const style = getComputedStyle(row);
          return [identity(row), Number(row.dataset.index), box.top, box.height,
            Number.parseFloat(style.translate.split(/\s+/)[1] ?? '0') || 0,
            Number.parseFloat(style.opacity), row.getAnimations().length];
        }),
        window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0,
        ...geometry(shell), ...geometry(pane?.querySelector('.app-chat-pane-header, .app-page-header') ?? null),
        ...geometry(pane?.querySelector('.app-composer-input') ?? null),
      ].map(round);
      const value = JSON.stringify(frame);
      const last = previous.get(viewport);
      if (!last || last.value !== value || at - last.at >= 1000) {
        frames.push([at, ...frame]); previous.set(viewport, { value, at });
      }
      if (frames.length >= 60) flush();
    }
    if (performance.now() - flushedAt >= 500) { flush(); flushedAt = performance.now(); }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

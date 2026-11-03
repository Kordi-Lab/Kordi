import { syncOnVisible } from './syncOnVisible';

type Timer = ReturnType<typeof setTimeout>;
type PollingEnvironment = {
  win: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  doc: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { hidden: boolean };
  schedule: (callback: () => void, delay: number) => Timer;
  cancel: (timer: Timer | undefined) => void;
};

/** Resume pending work immediately on focus, even when a hidden WebView throttled its timer. */
export function startCommonGroundPolling(poll: () => Promise<number | null>, env: PollingEnvironment): () => void {
  let stopped = false;
  let running = false;
  let resume = false;
  let timer: Timer | undefined;
  const loop = async () => {
    if (stopped) return;
    if (running) { resume = true; return; }
    env.cancel(timer);
    running = true;
    let next: number | null = null;
    try {
      if (!env.doc.hidden) next = await poll();
    } finally {
      running = false;
      if (!stopped) timer = env.schedule(() => { void loop(); }, resume ? 0 : next ?? 1_000);
      resume = false;
    }
  };
  const stopSync = syncOnVisible(() => { void loop(); }, env.win, env.doc);
  timer = env.schedule(() => { void loop(); }, 1_000);
  return () => { stopped = true; env.cancel(timer); stopSync(); };
}

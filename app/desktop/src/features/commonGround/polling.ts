import { syncOnVisible } from './syncOnVisible';

type Timer = ReturnType<typeof setTimeout>;
type PollingEnvironment = {
  win: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  doc: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { hidden: boolean };
  schedule: (callback: () => void, delay: number) => Timer;
  cancel: (timer: Timer | undefined) => void;
};

/** Resume pending work immediately on focus, even when a hidden WebView throttled its timer. */
export function startCommonGroundPolling(poll: () => Promise<number | null>, { win, doc, schedule, cancel }: PollingEnvironment): () => void {
  let stopped = false;
  let running = false;
  let timer: Timer | undefined;
  const loop = async () => {
    if (stopped || running) return;
    cancel(timer);
    running = true;
    let next: number | null = null;
    try {
      if (!doc.hidden) next = await poll();
    } finally {
      running = false;
      if (!stopped) timer = schedule(() => { void loop(); }, next ?? 1_000);
    }
  };
  const stopSync = syncOnVisible(() => { void loop(); }, win, doc);
  timer = schedule(() => { void loop(); }, 1_000);
  return () => { stopped = true; cancel(timer); stopSync(); };
}

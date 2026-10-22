// Cards stay in sync across the account's devices: when Grounding becomes visible again
// (window focus, or the document turning visible), the store refetches the cards and the
// current card. The store throttles the refetch.

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** Calls `sync` on window focus and when the document becomes visible; returns the cleanup. */
export function syncOnVisible(sync: () => unknown, win: Listenable, doc: Listenable & { hidden: boolean }): () => void {
  const onFocus = () => { void sync(); };
  const onVisibility = () => { if (!doc.hidden) void sync(); };
  win.addEventListener('focus', onFocus);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('focus', onFocus);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';

import { initialPicks } from './buildRequest';
import type { CommonGroundStore } from './store';
import { saveSources } from './storeProfiles';
import type { CgSourcePicks } from './types';

/** Changes are saved this long after the last one. */
export const SOURCES_SAVE_MS = 800;

/**
 * The Build screen's picks, starting from the card's saved sources. With `save` on
 * (`commonGroundVersion` 3) each change is saved to the profile shortly after, and on leaving.
 */
export function useSourcePicks(store: CommonGroundStore, profileId: string | null, saved: CgSourcePicks | null | undefined, memory: boolean, save: boolean) {
  const [picks, setPicks] = useState(() => initialPicks(saved, memory));
  const latest = useRef(picks);
  const pending = useRef<CgSourcePicks | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next && profileId) void saveSources(store, profileId, next);
  }, [store, profileId]);
  useEffect(() => flush, [flush]);
  const change = useCallback((update: (current: CgSourcePicks) => CgSourcePicks) => {
    const next = update(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    setPicks(next);
    if (!save || !profileId) return;
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SOURCES_SAVE_MS);
  }, [flush, save, profileId]);
  return { picks, change };
}

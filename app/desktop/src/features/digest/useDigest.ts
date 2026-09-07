import { useCallback, useEffect, useRef, useState } from 'react';
import { digestClient } from './client';
import type { CalendarEvent, DigestResponse } from './types';

export function useDigest(accountId: string) {
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [calendarLoaded, setCalendarLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    signal ??= controllerRef.current?.signal;
    try {
      const [next, calendar] = await Promise.all([digestClient.read(accountId, signal), digestClient.calendar(accountId, signal)]);
      if (current === generation.current && !signal?.aborted) { setDigest(next); setEvents(calendar.events); setCalendarLoaded(true); setError(null); }
      return next;
    } catch (caught) {
      if (current === generation.current && !signal?.aborted) setError(caught instanceof Error ? caught.message : 'Could not load the digest.');
      throw caught;
    }
  }, [accountId]);
  useEffect(() => {
    const controller = new AbortController(); controllerRef.current = controller; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await reload(controller.signal); } catch { /* Error is visible beside the retained snapshot. */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [reload]);
  return { digest, events, error, reload, calendarLoaded };
}

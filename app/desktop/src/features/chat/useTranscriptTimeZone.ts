import { useEffect, useRef, useState } from 'react';
import { formatDesktopDate, refreshDesktopTimeZone } from '@/lib/time';

function deviceTimeZone() {
  return refreshDesktopTimeZone();
}

function clockContext() {
  const timeZone = deviceTimeZone();
  const now = Date.now();
  return { timeZone, day: formatDesktopDate(now, { timeZone }), now };
}

/** Refresh local clock labels after travel, including while the window stays open. */
export function useTranscriptTimeZone() {
  const [context, setContext] = useState(clockContext);
  const contextRef = useRef(context);

  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) {
        const next = clockContext();
        if (contextRef.current.timeZone !== next.timeZone || contextRef.current.day !== next.day) {
          contextRef.current = next;
          setContext(next);
        }
      }
    };
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', refresh);
    refresh();
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  return context;
}

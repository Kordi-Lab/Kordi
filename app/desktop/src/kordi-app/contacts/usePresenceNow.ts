import { useEffect, useState } from 'react';

const PRESENCE_TICK_MS = 30_000;

/** Current time, refreshed every 30 seconds so "last seen N minutes ago" lines stay current. */
export function usePresenceNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), PRESENCE_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

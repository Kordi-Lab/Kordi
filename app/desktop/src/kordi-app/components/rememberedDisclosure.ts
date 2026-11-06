import { useCallback, useState } from 'react';

const REMEMBERED_LIMIT = 2000;
const remembered = new Map<string, boolean>();

export function forgetRememberedDisclosures() {
  remembered.clear();
}

/**
 * Fold state that survives transcript re-renders, virtualized remounts and the
 * live-to-finished handoff for the rest of the app session. Without a key it is
 * ordinary component state.
 */
export function useRememberedDisclosure(key: string | undefined, initial: boolean) {
  const [expanded, setExpanded] = useState(() => (key ? remembered.get(key) : undefined) ?? initial);
  const toggle = useCallback(() => {
    setExpanded(value => {
      const next = !value;
      if (key) {
        remembered.delete(key);
        remembered.set(key, next);
        if (remembered.size > REMEMBERED_LIMIT) remembered.delete(remembered.keys().next().value!);
      }
      return next;
    });
  }, [key]);
  return [expanded, toggle] as const;
}

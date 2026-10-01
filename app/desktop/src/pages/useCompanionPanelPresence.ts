import { useEffect, useLayoutEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

export function focusCompanionToggleFromPanel() {
  if (typeof document === 'undefined') return;
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest('.app-companion-panel-motion, .app-native-companion-titlebar')) {
    document.querySelector<HTMLButtonElement>('.app-companion-toolbar button:not(:disabled)')?.focus({ preventScroll: true });
  }
}

/** Keep content mounted through its exit; rapid reversals reuse the same panel. */
export function useCompanionPanelPresence(open: boolean, conversationId: string) {
  const reducedMotion = useReducedMotion();
  const [retained, setRetained] = useState({ conversationId, open });
  if (open && (!retained.open || retained.conversationId !== conversationId)) {
    setRetained({ conversationId, open: true });
  }
  const present = open || (retained.conversationId === conversationId && retained.open);
  const duration = reducedMotion ? 0 : 260;

  useLayoutEffect(() => {
    if (open || !present) return;
    focusCompanionToggleFromPanel();
  }, [open, present]);

  useEffect(() => {
    if (open || !present) return;
    const timer = window.setTimeout(() => setRetained({ conversationId, open: false }), duration);
    return () => window.clearTimeout(timer);
  }, [open, present, conversationId, duration]);

  return { present, duration };
}

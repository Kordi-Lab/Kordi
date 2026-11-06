import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Places a small prompt beside the Help button, once startup layout and launch
 * dialogs settle. Returns null while the button is hidden or a dialog is open.
 */
export function useHelpCornerPosition(trigger: RefObject<HTMLButtonElement | null>) {
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    let pending = 0;
    let candidate = '';
    const measure = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0 || rect.bottom > window.innerHeight || rect.right > window.innerWidth
        || document.visibilityState !== 'visible'
        || trigger.current?.closest('[inert], [aria-hidden="true"], [data-ready="false"]')
        || document.querySelector('[role="dialog"], [role="alertdialog"], .app-cloud-login-shell[data-active="true"]')) {
        window.clearTimeout(pending);
        candidate = '';
        setPosition(null);
        return;
      }
      const next = { left: Math.max(8, Math.min(rect.right + 12, window.innerWidth - 248)), bottom: Math.max(8, Math.min(window.innerHeight - rect.bottom, window.innerHeight - 200)) };
      const key = `${next.left}:${next.bottom}`;
      if (key === candidate) return;
      candidate = key;
      window.clearTimeout(pending);
      // Let startup layout and launch dialogs settle before introducing help.
      setPosition(null);
      pending = window.setTimeout(() => setPosition(next), 250);
    };
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('visibilitychange', measure);
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true });
    const workspace = trigger.current?.closest('.app-cloud-workspace-surface');
    if (workspace) observer.observe(workspace, { attributes: true, attributeFilter: ['inert', 'aria-hidden', 'data-ready'] });
    const gate = document.querySelector('.app-cloud-login-shell');
    if (gate) observer.observe(gate, { attributes: true, attributeFilter: ['data-active'] });
    const resize = new ResizeObserver(measure);
    if (trigger.current) resize.observe(trigger.current);
    return () => { window.clearTimeout(pending); observer.disconnect(); resize.disconnect(); window.removeEventListener('resize', measure); document.removeEventListener('visibilitychange', measure); };
  }, [trigger]);
  return position;
}

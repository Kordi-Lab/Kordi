import { useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export function HelpWelcome({ trigger, onStart, onDismiss }: {
  trigger: RefObject<HTMLButtonElement | null>;
  onStart: () => void;
  onDismiss: () => void;
}) {
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
  if (!position) return null;
  return createPortal(<aside className="app-transient-surface fixed z-30 w-60 rounded-xl border p-4 text-left text-foreground" style={position} aria-label="Welcome to Kordi">
    <p className="text-[13px] font-semibold">Get to know Kordi</p>
    <p className="my-2 text-[12px] leading-5">Explore cards, people, chats, and setup. Help is always here.</p>
    <div className="flex items-center gap-3">
      <button className="app-button-primary rounded-lg px-3 py-2 text-xs" onClick={onStart}>Explore Kordi</button>
      <button className="text-xs" onClick={onDismiss}>Not now</button>
    </div>
  </aside>, document.body);
}

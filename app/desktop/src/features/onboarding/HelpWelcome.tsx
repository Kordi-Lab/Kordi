import { useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export function HelpWelcome({ trigger, onStart, onDismiss }: {
  trigger: RefObject<HTMLButtonElement | null>;
  onStart: () => void;
  onDismiss: () => void;
}) {
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      if (trigger.current?.closest('[inert], [aria-hidden="true"]') || document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        setPosition(null);
        return;
      }
      const next = { left: Math.max(8, Math.min(rect.right + 12, window.innerWidth - 248)), bottom: Math.max(8, Math.min(window.innerHeight - rect.bottom, window.innerHeight - 200)) };
      setPosition((current) => current?.left === next.left && current.bottom === next.bottom ? current : next);
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true });
    const workspace = trigger.current?.closest('.app-cloud-workspace-surface');
    if (workspace) observer.observe(workspace, { attributes: true, attributeFilter: ['inert', 'aria-hidden', 'data-ready'] });
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
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

import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useHelpCornerPosition } from './helpCornerPosition';

export function HelpWelcome({ trigger, onStart, onDismiss }: {
  trigger: RefObject<HTMLButtonElement | null>;
  onStart: () => void;
  onDismiss: () => void;
}) {
  const position = useHelpCornerPosition(trigger);
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

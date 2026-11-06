import { useSyncExternalStore } from 'react';

// The Personal agent page replaces the chat pane while it is open. It opens
// from its sidebar entry and closes when a chat is chosen: the entry closes
// it when the selection changes or the entry goes away (another channel),
// and the sidebar closes it for a click on the chat already selected.

let open = false;
let openSession: ((sessionId: string) => void) | null = null;
const listeners = new Set<() => void>();

function setOpen(next: boolean) {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function read() {
  return open;
}

export function openPersonalAgentPage() {
  setOpen(true);
}

export function closePersonalAgentPage() {
  setOpen(false);
}

export function usePersonalAgentPageOpen() {
  return useSyncExternalStore(subscribe, read, read);
}

/** The sidebar registers how a chat opens, so the page can open the agent's chat. */
export function registerPersonalAgentSessionOpener(opener: (sessionId: string) => void) {
  openSession = opener;
  return () => { if (openSession === opener) openSession = null; };
}

/** Closes the page and opens `sessionId` as an ordinary chat. */
export function openPersonalAgentSession(sessionId: string) {
  closePersonalAgentPage();
  openSession?.(sessionId);
}

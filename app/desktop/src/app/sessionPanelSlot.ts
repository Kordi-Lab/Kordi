import { useSyncExternalStore } from 'react';

/**
 * Pages whose list belongs in the sidebar session panel (Contacts, Factory) render it into this
 * slot, so the list has the same width, backdrop, header and search as the Chats list while its
 * state stays with the page. Without a slot (previews, tests) the list renders in place.
 */
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ref callback for the element in the session panel that hosts a page's list. */
export function setSessionPanelSlot(element: HTMLElement | null) {
  if (slot === element) return;
  slot = element;
  listeners.forEach((listener) => listener());
}

export function useSessionPanelSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}

import { useSyncExternalStore } from 'react';

let busy = false;
const listeners = new Set<() => void>();

/**
 * True while the group invitation prompt is checking for or showing an
 * invitation. First-run help waits so the two prompts never overlap.
 */
export function setGroupInvitationPromptBusy(next: boolean) {
  if (busy === next) return;
  busy = next;
  listeners.forEach((listener) => listener());
}

export const isGroupInvitationPromptBusy = () => busy;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useGroupInvitationPromptBusy() {
  return useSyncExternalStore(subscribe, isGroupInvitationPromptBusy, () => false);
}

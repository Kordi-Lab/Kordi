import { useSyncExternalStore } from 'react';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

// Shared account-route state for chats opened from a provider page and for the
// active chat. The route identifies the account and model, not where it runs.

export type KordiCloudChatRequest = { route: DesktopChatMessageRoute; sessionId: string | null };

let pendingRequest: KordiCloudChatRequest | null = null;
let activeChatRoute: DesktopChatMessageRoute | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Records the route for the chat being opened; `sessionId` null means the chat that becomes active. */
export function requestKordiCloudChatRoute(route: DesktopChatMessageRoute, sessionId: string | null = null) {
  pendingRequest = { route, sessionId };
  notify();
}

/** Clears the request once its route is applied; a newer request is kept. */
export function completeKordiCloudChatRequest(request: KordiCloudChatRequest) {
  if (pendingRequest !== request) return;
  pendingRequest = null;
  notify();
}

export function currentKordiCloudChatRequest(): KordiCloudChatRequest | null {
  return pendingRequest;
}

export function useKordiCloudChatRequest(): KordiCloudChatRequest | null {
  return useSyncExternalStore(subscribe, () => pendingRequest, () => null);
}

export function setActiveChatRoute(route: DesktopChatMessageRoute | null) {
  const next = route?.model ? { model: route.model, authProvider: route.authProvider ?? null, authChoice: route.authChoice ?? null, thinking: route.thinking ?? null } : null;
  if (JSON.stringify(next) === JSON.stringify(activeChatRoute)) return;
  activeChatRoute = next;
  notify();
}

export function useActiveChatRoute(): DesktopChatMessageRoute | null {
  return useSyncExternalStore(subscribe, () => activeChatRoute, () => null);
}

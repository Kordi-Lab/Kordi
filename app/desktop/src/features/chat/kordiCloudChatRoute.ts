import { useSyncExternalStore } from 'react';
import { routeRunsOnKordiCloud } from '@/features/cloud/cloudAgentRuntimeRoute';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

// Two small pieces of shared state for chats that run on Kordi Cloud:
// - a chat opened from a provider page with a hosted-only account asks for
//   its route, which the route owner applies to the session it opens;
// - the active chat's route: the composer marks its hosted account and shows
//   "Runs on Kordi Cloud" while that route runs there.

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

export function useActiveChatRunsOnKordiCloud(): boolean {
  return routeRunsOnKordiCloud(useActiveChatRoute());
}

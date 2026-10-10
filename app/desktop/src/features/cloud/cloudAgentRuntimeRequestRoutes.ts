import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type { CanonicalSessionRequestRoute } from '@/lib/desktopCanonicalSessionRoutes';
import type { CanonicalSessionMessage } from '@/kordi-app/types';

import type { CloudMessage } from './cloudMessageTypes';
import {
  CLOUD_DIRECT_MESSAGE_PREFIX,
  cloudDirectMessageAgentRuntimeRoute,
} from './cloudDirectMessages';
import { qualifiedRouteModel } from './cloudAgentRuntimeRoute';

// Decoding an envelope is the expensive part; message objects are immutable rows.
const cloudRequestRouteCache = new WeakMap<CloudMessage, DesktopChatMessageRoute | null>();

function qualifiedRoute(route: DesktopChatMessageRoute | null): DesktopChatMessageRoute | null {
  if (!route?.model?.trim()) return null;
  return { ...route, model: qualifiedRouteModel(route) ?? route.model.trim() };
}

/**
 * The route the person's own agent request carried in its envelope, if any.
 * A session created before its route was persisted still has this record of
 * the account that ran it, so a restart can restore that route.
 */
export function cloudAgentRequestRuntimeRoute(
  message: CloudMessage,
  accountId: string | null | undefined,
): DesktopChatMessageRoute | null {
  const localAccountId = accountId?.trim();
  if (
    !localAccountId
    || message.fromAccountId !== localAccountId
    || message.toAccountId !== localAccountId
    || !message.sessionId?.trim()
    || message.messageKind === 'agent-model-change'
    || typeof message.body !== 'string'
    || !message.body.startsWith(CLOUD_DIRECT_MESSAGE_PREFIX)
  ) return null;
  const cached = cloudRequestRouteCache.get(message);
  if (cached !== undefined) return cached;
  const route = qualifiedRoute(cloudDirectMessageAgentRuntimeRoute(message.body));
  cloudRequestRouteCache.set(message, route);
  return route;
}

/** A route object stored with a request sent from this desktop, if it names a model. */
export function storedAgentRequestRuntimeRoute(route: unknown): DesktopChatMessageRoute | null {
  if (!route || typeof route !== 'object' || Array.isArray(route)) return null;
  const record = route as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === 'string' ? record[key].trim() : '');
  return qualifiedRoute({
    model: text('model'),
    ...(text('authProvider') ? { authProvider: text('authProvider') } : {}),
    ...(text('authChoice') ? { authChoice: text('authChoice') } : {}),
    ...(text('thinking') ? { thinking: text('thinking') } : {}),
  });
}

/** The route a request sent from this desktop stored with its delivered message, if any. */
export function canonicalAgentRequestRuntimeRoute(
  message: CanonicalSessionMessage,
): DesktopChatMessageRoute | null {
  if (message.senderRole !== 'user' || message.sourceTransport !== 'desktop-chat-ui') return null;
  const content = message.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  return storedAgentRequestRuntimeRoute((content as { agentRuntimeRoute?: unknown }).agentRuntimeRoute);
}

/** A route a session recorded at one point of its history. */
export type SessionRuntimeRouteRecord = {
  sessionId: string;
  sequenceNum: number;
  updatedAtMs: number;
  route: DesktopChatMessageRoute;
};

/**
 * The local mirror's latest routed request per session, independent of which
 * transcript pages are loaded, so a restart restores every session's route.
 */
export function mirroredSessionRequestRouteRecords(
  rows: readonly CanonicalSessionRequestRoute[] | null | undefined,
): SessionRuntimeRouteRecord[] {
  const records: SessionRuntimeRouteRecord[] = [];
  for (const row of rows ?? []) {
    const sessionId = row.sessionId?.trim();
    const route = storedAgentRequestRuntimeRoute(row.route);
    if (!sessionId || !route?.model) continue;
    records.push({ sessionId, sequenceNum: row.sequenceNum, updatedAtMs: row.updatedAtMs, route });
  }
  return records;
}

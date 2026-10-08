import type { DesktopChatMessageRoute } from '@/lib/desktop';
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

/** The route a request sent from this desktop stored with its delivered message, if any. */
export function canonicalAgentRequestRuntimeRoute(
  message: CanonicalSessionMessage,
): DesktopChatMessageRoute | null {
  if (message.senderRole !== 'user' || message.sourceTransport !== 'desktop-chat-ui') return null;
  const content = message.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const route = (content as { agentRuntimeRoute?: unknown }).agentRuntimeRoute;
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

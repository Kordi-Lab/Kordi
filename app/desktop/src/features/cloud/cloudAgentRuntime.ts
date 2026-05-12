import type { DesktopChatMessageRoute } from '@/lib/desktop';

import { CLOUD_AGENT_RUNTIME_SESSION_PREFIX } from './cloudAgentMessages';
import { cloudPeerAccountIdFromConversationId } from './cloudBridgeState';

function cleanText(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function canonicalBridgeConversationId(sessionId: string): string | null {
  const prefix = 'session:bridge:';
  if (!sessionId.startsWith(prefix)) return null;
  const value = sessionId.slice(prefix.length);
  return value || null;
}

function canonicalCloudDirectPeerAccountId(sessionId: string): string | null {
  const prefix = 'session:direct-person:';
  if (!sessionId.startsWith(prefix)) return null;
  const parts = sessionId.slice(prefix.length).split(':').map((part) => part.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

export function cloudAgentRuntimeSessionId(accountId?: string | null, cloudSessionKey?: string | null): string | null {
  const localAccountId = cleanText(accountId);
  const rawSessionKey = cleanText(cloudSessionKey);
  if (!localAccountId || !rawSessionKey) return null;

  if (rawSessionKey.startsWith(CLOUD_AGENT_RUNTIME_SESSION_PREFIX)) return rawSessionKey;

  const bridgeConversationId = canonicalBridgeConversationId(rawSessionKey) ?? rawSessionKey;
  const peerAccountId = cloudPeerAccountIdFromConversationId(bridgeConversationId)
    ?? canonicalCloudDirectPeerAccountId(rawSessionKey);
  const runtimeTargetId = cleanText(peerAccountId) ?? rawSessionKey;
  return `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}${localAccountId}:${runtimeTargetId}`;
}

export function compactCloudAgentRuntimeRoute(route?: DesktopChatMessageRoute | null): DesktopChatMessageRoute | null {
  const compacted: DesktopChatMessageRoute = {};
  const model = cleanText(route?.model);
  const authProvider = cleanText(route?.authProvider);
  const authChoice = cleanText(route?.authChoice);
  const thinking = cleanText(route?.thinking);
  if (model) compacted.model = model;
  if (authProvider) compacted.authProvider = authProvider;
  if (authChoice) compacted.authChoice = authChoice;
  if (thinking) compacted.thinking = thinking;
  return Object.keys(compacted).length > 0 ? compacted : null;
}

export function cloudAgentRuntimeRouteForSession(
  routesByRuntimeSessionId: Record<string, DesktopChatMessageRoute> | null | undefined,
  runtimeSessionId: string | null | undefined,
): DesktopChatMessageRoute | null {
  const route = runtimeSessionId ? routesByRuntimeSessionId?.[runtimeSessionId] : null;
  return compactCloudAgentRuntimeRoute(route);
}

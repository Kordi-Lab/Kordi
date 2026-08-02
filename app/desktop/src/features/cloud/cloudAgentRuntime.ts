import type { DesktopChatMessageRoute } from '@/lib/desktop';

import type { CloudAgentDefinition } from './cloudAgents';
import { CLOUD_AGENT_RUNTIME_SESSION_PREFIX } from './cloudAgentMessages';
import { cloudPeerAccountIdFromConversationId } from './cloudCollaborationState';

function cleanText(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function legacyCanonicalCollaborationConversationId(sessionId: string): string | null {
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

  const collaborationConversationId = legacyCanonicalCollaborationConversationId(rawSessionKey) ?? rawSessionKey;
  const peerAccountId = cloudPeerAccountIdFromConversationId(collaborationConversationId)
    ?? canonicalCloudDirectPeerAccountId(rawSessionKey);
  const runtimeTargetId = cleanText(peerAccountId) ?? rawSessionKey;
  return `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}${localAccountId}:${runtimeTargetId}`;
}

export function cloudGroupAgentRuntimeSessionId(
  accountId?: string | null,
  groupId?: string | null,
  targetCloudAgentId?: string | null,
): string | null {
  const groupRuntimeSessionId = cloudAgentRuntimeSessionId(accountId, groupId);
  if (!groupRuntimeSessionId) return null;
  const targetAgentId = cleanText(targetCloudAgentId);
  return targetAgentId?.startsWith('cloud_agent_')
    ? `${groupRuntimeSessionId}:${targetAgentId}`
    : groupRuntimeSessionId;
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
  fallbackRoute?: DesktopChatMessageRoute | null,
): DesktopChatMessageRoute | null {
  const route = runtimeSessionId ? routesByRuntimeSessionId?.[runtimeSessionId] : null;
  return compactCloudAgentRuntimeRoute(route) ?? compactCloudAgentRuntimeRoute(fallbackRoute);
}

export function cloudAgentRuntimeRouteFromDefinition(
  definition: CloudAgentDefinition | null | undefined,
): DesktopChatMessageRoute | null {
  const routing = definition?.modelRouting;
  if (!routing) return null;
  return compactCloudAgentRuntimeRoute({
    model: typeof routing.defaultModel === 'string' ? routing.defaultModel : null,
    authProvider: typeof routing.defaultAuthProvider === 'string' ? routing.defaultAuthProvider : null,
    authChoice: typeof routing.defaultAuthChoice === 'string' ? routing.defaultAuthChoice : null,
    thinking: typeof routing.thinking === 'string' ? routing.thinking : null,
  });
}

export function cloudAgentRuntimeRouteForTargetCloudAgent(
  input: {
    targetCloudAgentId?: string | null;
    cloudAgentDefinitionsById?: Record<string, CloudAgentDefinition> | null;
    routesByRuntimeSessionId?: Record<string, DesktopChatMessageRoute> | null;
    runtimeSessionId?: string | null;
    fallbackRoute?: DesktopChatMessageRoute | null;
  },
): DesktopChatMessageRoute | null {
  const targetCloudAgentId = cleanText(input.targetCloudAgentId);
  const definitionRoute = targetCloudAgentId
    ? cloudAgentRuntimeRouteFromDefinition(input.cloudAgentDefinitionsById?.[targetCloudAgentId])
    : null;
  return definitionRoute ?? cloudAgentRuntimeRouteForSession(
    input.routesByRuntimeSessionId,
    input.runtimeSessionId,
    input.fallbackRoute,
  );
}

import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type { CanonicalSessionMessage } from '@/kordi-app/types';

import type { CloudMessage } from './authClient';
import type { CloudAgentDefinition } from './cloudAgents';
import { CLOUD_AGENT_RUNTIME_SESSION_PREFIX } from './cloudAgentMessages';
import {
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
} from './cloudCollaborationState';
import {
  cloudDirectMessageAgentRuntimeRoute,
  cloudDirectMessageDisplayText,
  encodeCloudDirectMessageEnvelope,
} from './cloudDirectMessages';
import {
  agentRuntimeRouteChangeNotice,
  cleanRuntimeRouteText as cleanText,
  modelFromAgentModelChangeNotice,
  qualifiedRouteModel,
  runtimeRouteProvider as routeProvider,
} from './cloudAgentRuntimeRoute';

export {
  agentRuntimeRouteChangeNotice,
  agentThinkingEffortLabel,
  modelFromAgentModelChangeNotice,
} from './cloudAgentRuntimeRoute';

export const CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND = 'agent-model-change';

export type CloudAgentRuntimeRouteChangeInput = {
  sessionId: string;
  model: string;
  thinking?: string | null;
  authProvider?: string | null;
  authChoice?: string | null;
  initialSessionTitle?: string | null;
};

function runtimeRouteFromUnknown(value: unknown): DesktopChatMessageRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const nested = record.agentRuntimeRoute;
  const route = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : record;
  return compactCloudAgentRuntimeRoute({
    model: typeof route.model === 'string'
      ? route.model
      : typeof route.defaultModel === 'string'
        ? route.defaultModel
        : null,
    authProvider: typeof route.authProvider === 'string'
      ? route.authProvider
      : typeof route.defaultAuthProvider === 'string'
        ? route.defaultAuthProvider
        : null,
    authChoice: typeof route.authChoice === 'string'
      ? route.authChoice
      : typeof route.defaultAuthChoice === 'string'
        ? route.defaultAuthChoice
        : null,
    thinking: typeof route.thinking === 'string' ? route.thinking : null,
  });
}

export function cloudAgentRuntimeRouteChangeFromBody(
  body?: string | null,
): DesktopChatMessageRoute | null {
  const normalizedBody = cleanText(body);
  if (!normalizedBody) return null;
  const envelopeRoute = cloudDirectMessageAgentRuntimeRoute(normalizedBody);
  if (envelopeRoute) return compactCloudAgentRuntimeRoute({
    ...envelopeRoute,
    model: qualifiedRouteModel(envelopeRoute),
  });
  const model = modelFromAgentModelChangeNotice(
    cloudDirectMessageDisplayText(normalizedBody),
  );
  return model ? compactCloudAgentRuntimeRoute({
    model,
    authProvider: routeProvider({ model }),
  }) : null;
}

export function encodeCloudAgentRuntimeRouteChange(
  route: DesktopChatMessageRoute,
  previousRoute?: DesktopChatMessageRoute | null,
): string {
  const compactRoute = compactCloudAgentRuntimeRoute({
    ...route,
    model: qualifiedRouteModel(route),
  });
  if (!compactRoute?.model) {
    throw new Error('A session runtime route change requires a model.');
  }
  if (compactRoute.authChoice?.startsWith('profile:')) {
    throw new Error('A synchronized session route cannot contain a local auth profile id.');
  }
  return encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: agentRuntimeRouteChangeNotice(compactRoute, previousRoute),
    agentRuntimeRoute: {
      model: compactRoute.model,
      authProvider: compactRoute.authProvider,
      // This is a non-secret profile selector (for example
      // `local-active-oauth`), never the credential payload itself.
      authChoice: compactRoute.authChoice,
      thinking: compactRoute.thinking,
    },
  });
}

function cloudMessageOrder(message: CloudMessage): [number, number, string] {
  const sequence = typeof message.conversationSequence === 'number'
    ? message.conversationSequence
    : Number.MAX_SAFE_INTEGER;
  const createdAtMs = Date.parse(message.createdAt);
  return [
    sequence,
    Number.isFinite(createdAtMs) ? createdAtMs : 0,
    message.messageId,
  ];
}

function compareCloudMessageOrder(
  left: CloudMessage,
  right: CloudMessage,
): number {
  const leftOrder = cloudMessageOrder(left);
  const rightOrder = cloudMessageOrder(right);
  return leftOrder[0] - rightOrder[0]
    || leftOrder[1] - rightOrder[1]
    || leftOrder[2].localeCompare(rightOrder[2]);
}

export function latestCloudAgentRuntimeRouteChangeBeforeRequest(
  messages: readonly CloudMessage[],
  request: CloudMessage,
): DesktopChatMessageRoute | null {
  const sessionId = cleanText(request.sessionId);
  if (!sessionId) return null;
  const requestSequence = request.conversationSequence;
  const requestCreatedAtMs = Date.parse(request.createdAt);
  const candidates = messages
    .filter((message) => {
      if (
        cleanText(message.sessionId) !== sessionId
        || message.messageKind !== CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND
        || !cloudAgentRuntimeRouteChangeFromBody(message.body)
      ) return false;
      if (
        typeof requestSequence === 'number'
        && typeof message.conversationSequence === 'number'
      ) return message.conversationSequence < requestSequence;
      const createdAtMs = Date.parse(message.createdAt);
      return Number.isFinite(createdAtMs)
        && Number.isFinite(requestCreatedAtMs)
        && createdAtMs <= requestCreatedAtMs;
    })
    .sort(compareCloudMessageOrder);
  const latest = candidates[candidates.length - 1];
  return cloudAgentRuntimeRouteChangeFromBody(latest?.body);
}

/** Legacy model-only accessor retained for older callers and persisted events. */
export function latestCloudAgentModelChangeBeforeRequest(
  messages: readonly CloudMessage[],
  request: CloudMessage,
): string | null {
  return latestCloudAgentRuntimeRouteChangeBeforeRequest(
    messages,
    request,
  )?.model ?? null;
}

export function cloudAgentRuntimeRouteAfterModelChange(
  current: DesktopChatMessageRoute | null | undefined,
  change: DesktopChatMessageRoute | string | null | undefined,
  localExecutionRoute?: DesktopChatMessageRoute | null,
): DesktopChatMessageRoute | null {
  const changeRoute = typeof change === 'string'
    ? compactCloudAgentRuntimeRoute({ model: change })
    : compactCloudAgentRuntimeRoute(change);
  if (!changeRoute) return compactCloudAgentRuntimeRoute(current);
  const nextModel = qualifiedRouteModel({
    ...current,
    ...changeRoute,
  });
  const provider = routeProvider(changeRoute)
    ?? routeProvider({ model: nextModel })
    ?? routeProvider(current);
  const currentProvider = routeProvider(current);
  const localProvider = routeProvider(localExecutionRoute);
  const normalizedProvider = cleanText(provider)?.toLowerCase() ?? null;
  const synchronizedAuthChoice = cleanText(changeRoute.authChoice)
    ?? (normalizedProvider && currentProvider === normalizedProvider
      ? cleanText(current?.authChoice)
      : normalizedProvider && localProvider === normalizedProvider
        ? cleanText(localExecutionRoute?.authChoice)
        : null);
  const localAuthChoice = cleanText(localExecutionRoute?.authChoice);
  const authChoice = synchronizedAuthChoice?.startsWith('profile:')
    && normalizedProvider
    && localProvider === normalizedProvider
    && localAuthChoice
    ? localAuthChoice
    : synchronizedAuthChoice;
  return compactCloudAgentRuntimeRoute({
    ...current,
    model: nextModel,
    authProvider: provider,
    authChoice,
    thinking: changeRoute.thinking ?? current?.thinking,
  });
}

export function applyCloudAgentModelChangeMessages(
  current: Record<string, DesktopChatMessageRoute>,
  accountId: string | null | undefined,
  messages: CanonicalSessionMessage[] | null | undefined,
  localExecutionRoute?: DesktopChatMessageRoute | null,
): Record<string, DesktopChatMessageRoute> {
  if (!cleanText(accountId) || !messages?.length) return current;

  const latestBySessionId = new Map<string, CanonicalSessionMessage>();
  for (const message of messages) {
    if (message.messageKind !== CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND) continue;
    const route = runtimeRouteFromUnknown(message.content)
      ?? cloudAgentRuntimeRouteChangeFromBody(message.contentText);
    if (!route?.model) continue;
    const existing = latestBySessionId.get(message.sessionId);
    if (!existing
      || message.sequenceNum > existing.sequenceNum
      || (message.sequenceNum === existing.sequenceNum && message.updatedAtMs > existing.updatedAtMs)) {
      latestBySessionId.set(message.sessionId, message);
    }
  }

  let next = current;
  for (const [sessionId, message] of latestBySessionId) {
    const changeRoute = runtimeRouteFromUnknown(message.content)
      ?? cloudAgentRuntimeRouteChangeFromBody(message.contentText);
    const runtimeSessionId = cloudAgentRuntimeSessionId(accountId, sessionId);
    if (!changeRoute?.model || !runtimeSessionId) continue;

    const existing = current[runtimeSessionId] ?? {};
    const synchronized = cloudAgentRuntimeRouteAfterModelChange(
      existing,
      changeRoute,
      localExecutionRoute,
    );
    if (!synchronized) continue;
    if (
      cleanText(existing.model) === cleanText(synchronized.model)
      && routeProvider(existing) === routeProvider(synchronized)
      && cleanText(existing.authChoice) === cleanText(synchronized.authChoice)
      && cleanText(existing.thinking) === cleanText(synchronized.thinking)
    ) continue;
    if (next === current) next = { ...current };
    next[runtimeSessionId] = synchronized;
  }
  return next;
}

export function applyCloudAgentRuntimeRouteChangeCloudMessages(
  current: Record<string, DesktopChatMessageRoute>,
  accountId: string | null | undefined,
  messages: readonly CloudMessage[] | null | undefined,
  localExecutionRoute?: DesktopChatMessageRoute | null,
): Record<string, DesktopChatMessageRoute> {
  const localAccountId = cleanText(accountId);
  if (!localAccountId || !messages?.length) return current;
  const latestBySessionId = new Map<string, CloudMessage>();
  for (const message of messages) {
    const sessionId = cleanText(message.sessionId);
    if (
      !sessionId
      || message.fromAccountId !== localAccountId
      || message.messageKind !== CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND
      || !cloudAgentRuntimeRouteChangeFromBody(message.body)?.model
    ) continue;
    const existing = latestBySessionId.get(sessionId);
    if (!existing || compareCloudMessageOrder(existing, message) < 0) {
      latestBySessionId.set(sessionId, message);
    }
  }

  let next = current;
  for (const [sessionId, message] of latestBySessionId) {
    const runtimeSessionId = cloudAgentRuntimeSessionId(
      localAccountId,
      sessionId,
    );
    const changeRoute = cloudAgentRuntimeRouteChangeFromBody(message.body);
    if (!runtimeSessionId || !changeRoute) continue;
    const existing = current[runtimeSessionId] ?? {};
    const synchronized = cloudAgentRuntimeRouteAfterModelChange(
      existing,
      changeRoute,
      localExecutionRoute,
    );
    if (!synchronized) continue;
    if (
      cleanText(existing.model) === cleanText(synchronized.model)
      && routeProvider(existing) === routeProvider(synchronized)
      && cleanText(existing.authChoice) === cleanText(synchronized.authChoice)
      && cleanText(existing.thinking) === cleanText(synchronized.thinking)
    ) continue;
    if (next === current) next = { ...current };
    next[runtimeSessionId] = synchronized;
  }
  return next;
}

export function applySynchronizedCloudAgentRuntimeRoutes(
  current: Record<string, DesktopChatMessageRoute>,
  accountId: string | null | undefined,
  canonicalMessages: CanonicalSessionMessage[] | null | undefined,
  cloudMessages: readonly CloudMessage[] | null | undefined,
  localExecutionRoute?: DesktopChatMessageRoute | null,
): Record<string, DesktopChatMessageRoute> {
  // Canonical history can lag the reliable Cloud stream while its mirror is
  // being hydrated. Apply it first as a recovery source, then let the ordered
  // Cloud model-change events win in the same state transition. Keeping both
  // projections in one reducer prevents two React effects from repeatedly
  // overwriting the session route with different snapshots.
  const recovered = applyCloudAgentModelChangeMessages(
    current,
    accountId,
    canonicalMessages,
    localExecutionRoute,
  );
  return applyCloudAgentRuntimeRouteChangeCloudMessages(
    recovered,
    accountId,
    cloudMessages,
    localExecutionRoute,
  );
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
  const explicitSessionId = cloudSessionIdFromConversationId(
    collaborationConversationId,
  );
  const peerAccountId = cloudPeerAccountIdFromConversationId(
    collaborationConversationId,
  );
  const canonicalPeerAccountId = canonicalCloudDirectPeerAccountId(
    rawSessionKey,
  );
  const runtimeTargetId = cleanText(explicitSessionId)
    ?? (canonicalPeerAccountId ? rawSessionKey : null)
    ?? cleanText(peerAccountId)
    ?? rawSessionKey;
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

export function cloudGroupAgentRequestRuntimeSessionId(
  runtimeSessionId: string,
  requestId: string,
): string {
  return `${runtimeSessionId}:request:${requestId}`;
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
    requestRoute?: DesktopChatMessageRoute | null;
  },
): DesktopChatMessageRoute | null {
  const requestRoute = compactCloudAgentRuntimeRoute(input.requestRoute);
  const targetCloudAgentId = cleanText(input.targetCloudAgentId);
  const definitionRoute = targetCloudAgentId
    ? cloudAgentRuntimeRouteFromDefinition(input.cloudAgentDefinitionsById?.[targetCloudAgentId])
    : null;
  const sessionRoute = cloudAgentRuntimeRouteForSession(
    input.routesByRuntimeSessionId,
    input.runtimeSessionId,
    null,
  );
  const hostRoute = sessionRoute
    ?? definitionRoute
    ?? compactCloudAgentRuntimeRoute(input.fallbackRoute);
  if (!requestRoute) return hostRoute;
  if (!hostRoute) return requestRoute;

  const requestProvider = routeProvider(requestRoute);
  const hostProvider = routeProvider(hostRoute);
  const providerChanged = Boolean(
    requestProvider
    && hostProvider
    && requestProvider !== hostProvider,
  );

  return compactCloudAgentRuntimeRoute({
    model: requestRoute.model ?? hostRoute.model,
    thinking: requestRoute.thinking ?? hostRoute.thinking,
    // The request is the authoritative per-session snapshot. Reuse the Mac's
    // credential only when it belongs to that provider; otherwise use the
    // synchronized provider choice carried by the request.
    authProvider: requestRoute.authProvider ?? hostRoute.authProvider,
    authChoice: providerChanged
      ? requestRoute.authChoice
      : hostRoute.authChoice ?? requestRoute.authChoice,
  });
}

import { CLOUD_HOST_SENTINEL } from '@/features/cloud/cloudContactMapping';

const CLOUD_CONVERSATION_PREFIX = 'cloud:conversation:';
const LEGACY_CLOUD_CONVERSATION_PREFIX = `bridge:${CLOUD_HOST_SENTINEL}:`;
const SESSION_SUFFIX = ':session:';
const SYSTEM_AGENT_SESSION_PREFIX = 'session:direct-system-agent:';

function decodeIdPart(value: string): string | null {
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return null;
  }
}

function conversationParts(conversationId: string): {
  peerAccountId: string;
  sessionId: string | null;
  kind: 'person' | 'agent';
} | null {
  if (conversationId.startsWith(CLOUD_CONVERSATION_PREFIX)) {
    let rest = conversationId.slice(CLOUD_CONVERSATION_PREFIX.length);
    const sessionIndex = rest.indexOf(SESSION_SUFFIX);
    const encodedSessionId = sessionIndex >= 0
      ? rest.slice(sessionIndex + SESSION_SUFFIX.length)
      : null;
    if (sessionIndex >= 0) rest = rest.slice(0, sessionIndex);
    const kind = rest.endsWith(':person') ? 'person' : 'agent';
    if (rest.endsWith(':person')) rest = rest.slice(0, -':person'.length);
    else if (rest.endsWith(':agent')) rest = rest.slice(0, -':agent'.length);
    const peerAccountId = decodeIdPart(rest);
    if (!peerAccountId) return null;
    return {
      peerAccountId,
      sessionId: encodedSessionId ? decodeIdPart(encodedSessionId) : null,
      kind,
    };
  }

  if (!conversationId.startsWith(LEGACY_CLOUD_CONVERSATION_PREFIX)) return null;
  let rest = conversationId.slice(LEGACY_CLOUD_CONVERSATION_PREFIX.length);
  const sessionIndex = rest.indexOf(SESSION_SUFFIX);
  const encodedSessionId = sessionIndex >= 0
    ? rest.slice(sessionIndex + SESSION_SUFFIX.length)
    : null;
  if (sessionIndex >= 0) rest = rest.slice(0, sessionIndex);
  const kind = rest.endsWith(':person') ? 'person' : 'agent';
  if (kind === 'person') rest = rest.slice(0, -':person'.length);
  const peerAccountId = rest.trim();
  if (!peerAccountId) return null;
  return {
    peerAccountId,
    sessionId: encodedSessionId ? decodeIdPart(encodedSessionId) : null,
    kind,
  };
}

export function cloudCollaborationConversationId(
  peerAccountId: string,
  runtime = 'person',
  sessionId?: string | null,
): string {
  const kind = runtime.trim().toLowerCase() === 'person' ? 'person' : 'agent';
  const base = `${CLOUD_CONVERSATION_PREFIX}${encodeURIComponent(peerAccountId.trim())}:${kind}`;
  const normalizedSessionId = sessionId?.trim();
  return normalizedSessionId
    ? `${base}${SESSION_SUFFIX}${encodeURIComponent(normalizedSessionId)}`
    : base;
}

export function cloudPeerAccountIdFromConversationId(conversationId: string): string | null {
  return conversationParts(conversationId)?.peerAccountId ?? null;
}

export function cloudSessionIdFromConversationId(conversationId: string): string | null {
  return conversationParts(conversationId)?.sessionId ?? null;
}

export function cloudConversationKindFromConversationId(
  conversationId: string,
): 'person' | 'agent' | null {
  return conversationParts(conversationId)?.kind ?? null;
}

export function isCloudCollaborationConversationId(
  conversationId: string | null | undefined,
): boolean {
  return Boolean(conversationId && conversationParts(conversationId));
}

export function cloudDirectPersonSessionId(
  localAccountId: string,
  peerAccountId: string,
): string {
  return `session:direct-person:${[localAccountId.trim(), peerAccountId.trim()]
    .filter(Boolean)
    .sort()
    .join(':')}`;
}

export function cloudSystemAgentSessionId(
  localAccountId: string,
  agentId: string,
): string {
  return `${SYSTEM_AGENT_SESSION_PREFIX}${encodeURIComponent(localAccountId.trim())}:${encodeURIComponent(agentId.trim())}`;
}

export function cloudSystemAgentConversationId(
  localAccountId: string,
  ownerAccountId: string,
  agentId: string,
): string {
  return cloudCollaborationConversationId(
    ownerAccountId,
    'agent',
    cloudSystemAgentSessionId(localAccountId, agentId),
  );
}

export function isCloudSystemAgentSessionId(
  sessionId: string | null | undefined,
): boolean {
  return Boolean(sessionId?.trim().startsWith(SYSTEM_AGENT_SESSION_PREFIX));
}

export function cloudSystemAgentIdFromSessionId(
  sessionId: string | null | undefined,
): string | null {
  const normalizedSessionId = sessionId?.trim() ?? '';
  if (!normalizedSessionId.startsWith(SYSTEM_AGENT_SESSION_PREFIX)) return null;
  const encodedParts = normalizedSessionId
    .slice(SYSTEM_AGENT_SESSION_PREFIX.length)
    .split(':');
  if (encodedParts.length !== 2) return null;
  return decodeIdPart(encodedParts[1] ?? '');
}

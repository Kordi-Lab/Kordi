import { adminIdentityIdsFromMetadata } from '@/features/chat/chatCreateFlows';
import type { ComposerMentionOption } from '@/kordi-app/components';
import type { CanonicalSessionState, ConversationParticipant, DesktopChatState, ParticipantSpaceViewModel } from '@/kordi-app/types';

export function normalizeMentionSearch(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function canonicalAvatarSeed(state: CanonicalSessionState | null | undefined, identityId?: string | null) {
  const id = identityId?.trim();
  if (!state || !id) return null;
  return state.identities.find((identity) => identity.id === id)?.avatarKey?.trim() || null;
}

export function canonicalLocalAgentAvatarSeed(state: CanonicalSessionState | null | undefined) {
  if (!state) return null;
  const activeSeed = canonicalAvatarSeed(state, state.profile.activeAgentIdentityId);
  if (activeSeed) return activeSeed;
  const profileHumanIdentityId = state.profile.humanIdentityId?.trim();
  if (!profileHumanIdentityId) return null;
  return state.identities.find((identity) => (
    identity.kind === 'agent'
    && identity.source === 'local'
    && identity.ownerIdentityId === profileHumanIdentityId
  ))?.avatarKey?.trim() || null;
}

export type MentionQuery = {
  normalized: string;
  raw: string;
  trailingWhitespace: boolean;
};

export function currentMentionQuery(text: string): MentionQuery | null {
  const match = /(^|\s)@([^\s@\n\r]*)$/.exec(text);
  if (!match) return null;
  const raw = match[2];
  if (raw.length > 96) return null;
  return {
    normalized: normalizeMentionSearch(raw),
    raw,
    trailingWhitespace: /\s$/.test(raw),
  };
}

export function mentionTargetMatchesExactly(target: ComposerMentionOption, normalizedQuery: string) {
  return [target.value, target.label]
    .map(normalizeMentionSearch)
    .some((value) => value === normalizedQuery);
}

export function filterMentionTargets(targets: ComposerMentionOption[], query: MentionQuery | null) {
  if (query === null) return [];
  if (!query.normalized) return targets.slice(0, 8);
  if (query.trailingWhitespace && targets.some((target) => mentionTargetMatchesExactly(target, query.normalized))) {
    return [];
  }

  return targets
    .filter((target) => {
      const haystack = normalizeMentionSearch(`${target.label} ${target.detail ?? ''} ${target.nodeId} ${target.runtime}`);
      return haystack.includes(query.normalized);
    })
    .slice(0, 8);
}

export function removeSessionFromDesktopState(state: DesktopChatState | null, sessionId: string) {
  if (!state) return state;
  return {
    ...state,
    sessions: state.sessions.filter((session) => session.id !== sessionId),
    projects: state.projects.map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => session.id !== sessionId),
    })),
  };
}

export function removeSessionFromCanonicalState(state: CanonicalSessionState | null, sessionId: string) {
  if (!state) return state;
  return {
    ...state,
    sessions: state.sessions.filter((session) => session.id !== sessionId),
    participants: state.participants.filter((participant) => participant.sessionId !== sessionId),
    messages: state.messages.filter((message) => message.sessionId !== sessionId),
    delegatedExchanges: state.delegatedExchanges.filter((exchange) => exchange.sessionId !== sessionId),
    presence: state.presence.filter((presence) => presence.sessionId !== sessionId),
    contextSnapshots: state.contextSnapshots.filter((snapshot) => snapshot.sessionId !== sessionId),
  };
}

export function canonicalMetadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
}

export function sessionMetadataRecord(state: CanonicalSessionState | null, sessionId: string) {
  const session = state?.sessions.find((candidate) => candidate.id === sessionId);
  return canonicalMetadataRecord(session?.metadata);
}

export function activeGroupAdminIds(state: CanonicalSessionState | null, sessionId: string) {
  if (!state) return [];
  const metadataAdminIds = adminIdentityIdsFromMetadata(sessionMetadataRecord(state, sessionId));
  if (metadataAdminIds.length > 0) return metadataAdminIds;
  return state.participants
    .filter((participant) => (
      participant.sessionId === sessionId
      && participant.state === 'active'
      && participant.role === 'admin'
    ))
    .map((participant) => participant.identityId);
}

export function canonicalGroupParticipantsForSession(state: CanonicalSessionState | null, sessionId: string): ConversationParticipant[] {
  if (!state) return [];
  const identityById = new Map(state.identities.map((identity) => [identity.id, identity]));
  return state.participants
    .filter((participant) => participant.sessionId === sessionId && participant.state === 'active')
    .flatMap((participant) => {
      const identity = identityById.get(participant.identityId);
      if (!identity) return [];
      const role = identity.id === state.profile.humanIdentityId
        ? 'self'
        : participant.role === 'self'
          ? 'person'
          : participant.role;
      return [{
        id: identity.id,
        name: identity.displayName,
        kind: identity.kind === 'agent' ? 'agent' : 'human',
        role,
        source: identity.source,
        ownerIdentityId: identity.ownerIdentityId,
        bridgeHostId: identity.sourceHostId,
        bridgeNodeId: identity.bridgeNodeId,
        humanId: identity.humanId,
        agentId: identity.agentId,
        avatarKey: identity.avatarKey,
        profileImageUrl: identity.profileImageUrl,
      } satisfies ConversationParticipant];
    });
}

export function isParticipantSpaceSelfIdentity(participant: ParticipantSpaceViewModel['participants'][number]) {
  return participant.role === 'self'
    || (participant.kind === 'human' && participant.source === 'local');
}

export function participantSpaceNonSelfIdentities(space: ParticipantSpaceViewModel, kind?: 'human' | 'agent') {
  return space.participants.filter((participant) => (
    !isParticipantSpaceSelfIdentity(participant)
    && (!kind || participant.kind === kind)
    && participant.id.trim()
  ));
}

export function metadataStringArray(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeStoredGroupSpaceId(value: string) {
  const text = value.trim();
  return text.startsWith('group:') ? text.slice('group:'.length) : text;
}

export function metadataGroupSpaceId(metadata: Record<string, unknown>) {
  return normalizeStoredGroupSpaceId(
    metadataString(metadata, 'groupId')
    || metadataString(metadata, 'groupSpaceId')
    || metadataString(metadata, 'continuedFromSpaceId'),
  );
}

export function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function isNativeDesktopShell() {
  if (typeof window === 'undefined') return false;
  return typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

export function participantSpaceCreateKey(space: ParticipantSpaceViewModel) {
  return space.id.trim() || `${space.kind}:${space.participants.map((participant) => participant.id).join(',')}`;
}

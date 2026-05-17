import {
  adminIdentityIdsFromMetadata,
  buildChatGroupBridgeUpdateParticipants,
} from '@/features/chat/chatCreateFlows';
import type { ComposerMentionOption } from '@/kordi-app/components';
import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
  ConversationParticipant,
  DesktopBridgeSessionParticipant,
  DesktopBridgeSessionThreadMessage,
  DesktopChatState,
  ParticipantSpaceViewModel,
} from '@/kordi-app/types';

export function normalizeMentionSearch(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function shouldUseCloudSessionAction(edition: 'local' | 'cloud', sessionId: string) {
  if (edition !== 'cloud') return false;
  const trimmed = sessionId.trim();
  return trimmed.startsWith('session:') || trimmed.startsWith('bridge:cloud:');
}

export function canonicalAvatarSeed(state: CanonicalSessionState | null | undefined, identityId?: string | null) {
  const id = identityId?.trim();
  if (!state || !id) return null;
  return state.identities.find((identity) => identity.id === id)?.avatarKey?.trim() || null;
}

export function canonicalProfileImageUrl(state: CanonicalSessionState | null | undefined, identityId?: string | null) {
  const id = identityId?.trim();
  if (!state || !id) return null;
  return state.identities.find((identity) => identity.id === id)?.profileImageUrl?.trim() || null;
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

function optimisticCanonicalMessageStatusIsPreservable(message: CanonicalSessionMessage) {
  const content = message.content && typeof message.content === 'object' && !Array.isArray(message.content)
    ? message.content as Record<string, unknown>
    : {};
  const deliveryState = typeof content.deliveryState === 'string' ? content.deliveryState.trim().toLowerCase() : '';
  const status = message.status?.trim().toLowerCase() ?? '';
  return status === 'sending' || status === 'sent' || status === 'failed' || deliveryState === 'sending' || deliveryState === 'sent' || deliveryState === 'failed';
}

function isBridgeUiMessageToPreserve(message: CanonicalSessionMessage) {
  return message.sourceTransport === 'desktop-bridge-ui'
    && message.senderRole === 'user'
    && optimisticCanonicalMessageStatusIsPreservable(message);
}

function isBridgeContactLocalAgentUiMessageToPreserve(message: CanonicalSessionMessage) {
  return message.sourceTransport === 'desktop-chat-ui'
    && message.senderRole === 'user'
    && message.sessionId.startsWith('session:bridge:')
    && optimisticCanonicalMessageStatusIsPreservable(message);
}

function isBridgeSessionSyncMessageToPreserve(message: CanonicalSessionMessage) {
  if (!message.sessionId.startsWith('session:bridge:')) return false;
  const sourceTransport = message.sourceTransport?.trim().toLowerCase() ?? '';
  return sourceTransport === 'desktop-chat'
    || sourceTransport === 'desktop-chat-ui'
    || sourceTransport === 'desktop-bridge'
    || sourceTransport === 'desktop-bridge-parent'
    || sourceTransport === 'desktop-bridge-session-relay'
    || sourceTransport === 'desktop-bridge-outreach';
}

function normalizedCanonicalMessageText(value: string) {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function canonicalRefreshMessageAlreadyFetched(
  fetchedMessages: CanonicalSessionMessage[],
  currentMessage: CanonicalSessionMessage,
) {
  const currentText = normalizedCanonicalMessageText(currentMessage.contentText);
  return fetchedMessages.some((fetchedMessage) => (
    fetchedMessage.sessionId === currentMessage.sessionId
    && fetchedMessage.senderRole === currentMessage.senderRole
    && fetchedMessage.messageKind === currentMessage.messageKind
    && normalizedCanonicalMessageText(fetchedMessage.contentText) === currentText
    && Math.abs(fetchedMessage.createdAtMs - currentMessage.createdAtMs) <= 10_000
  ));
}

function shouldPreserveCanonicalMessageDuringRefresh(message: CanonicalSessionMessage) {
  return isBridgeUiMessageToPreserve(message)
    || isBridgeContactLocalAgentUiMessageToPreserve(message)
    || isBridgeSessionSyncMessageToPreserve(message);
}

export function mergeCanonicalStatePreservingBridgeUiMessages(
  fetched: CanonicalSessionState | null,
  current: CanonicalSessionState | null,
): CanonicalSessionState | null {
  if (!fetched || !current) return fetched;
  const fetchedMessageIds = new Set(fetched.messages.map((message) => message.id));
  const fetchedSessionIds = new Set(fetched.sessions.map((session) => session.id));
  const preservedMessages = current.messages.filter((message) => (
    shouldPreserveCanonicalMessageDuringRefresh(message)
    && !fetchedMessageIds.has(message.id)
    && fetchedSessionIds.has(message.sessionId)
    && !canonicalRefreshMessageAlreadyFetched(fetched.messages, message)
  ));
  if (preservedMessages.length === 0) return fetched;
  return {
    ...fetched,
    messages: [...fetched.messages, ...preservedMessages],
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

export function groupRenameMetadata(metadata: Record<string, unknown>, title: string, fallbackGroupSpaceId: string, updatedAtMs = Date.now()) {
  const groupId = metadataGroupSpaceId(metadata) || fallbackGroupSpaceId;
  return {
    ...metadata,
    customName: title,
    groupId,
    groupSpaceId: groupId,
    groupNameUpdatedAtMs: updatedAtMs,
  };
}

export function sessionRenameNoticeText(actorName: string | null | undefined, title: string, scope: 'group' | 'session') {
  const actor = actorName?.trim() || 'Someone';
  return `${actor} changed the ${scope} name to ${title.trim()}`;
}

export function canonicalIdentityDisplayName(state: CanonicalSessionState | null | undefined, identityId: string | null | undefined) {
  const id = identityId?.trim();
  if (!state || !id) return null;
  return state.identities.find((identity) => identity.id === id)?.displayName?.trim() || null;
}

function nonGenericGroupInviteTitle(value?: string | null) {
  const title = value?.trim();
  if (!title) return null;
  const normalized = title.toLowerCase();
  if (normalized === 'group' || normalized === 'session' || normalized === 'new session') {
    return null;
  }
  return title;
}

function groupInviteTitleFromSession(state: CanonicalSessionState | null, sessionId: string) {
  const session = state?.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return null;
  const metadata = canonicalMetadataRecord(session.metadata);
  return nonGenericGroupInviteTitle(metadataString(metadata, 'customName'))
    || nonGenericGroupInviteTitle(session.title);
}

export function canonicalGroupInviteTitleForSession(state: CanonicalSessionState | null, sessionId: string) {
  const session = state?.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return null;
  const metadata = canonicalMetadataRecord(session.metadata);
  const directTitle = groupInviteTitleFromSession(state, sessionId);
  if (directTitle) return directTitle;

  const groupSpaceId = metadataGroupSpaceId(metadata);
  if (groupSpaceId && groupSpaceId !== sessionId) {
    const groupSpaceTitle = groupInviteTitleFromSession(state, groupSpaceId);
    if (groupSpaceTitle) return groupSpaceTitle;
  }

  return null;
}

function canonicalInviteMessageSortKey(message: CanonicalSessionMessage) {
  return [message.sequenceNum, message.createdAtMs, message.id] as const;
}

function compareCanonicalInviteMessages(left: CanonicalSessionMessage, right: CanonicalSessionMessage) {
  const [leftSequence, leftCreatedAt, leftId] = canonicalInviteMessageSortKey(left);
  const [rightSequence, rightCreatedAt, rightId] = canonicalInviteMessageSortKey(right);
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt;
  return leftId.localeCompare(rightId);
}

export function canonicalSessionMessagesForGroupInvite(
  state: CanonicalSessionState | null,
  sessionId: string,
): DesktopBridgeSessionThreadMessage[] {
  const identityById = new Map((state?.identities ?? []).map((identity) => [identity.id, identity]));
  const snapshots: DesktopBridgeSessionThreadMessage[] = [];
  for (const message of [...(state?.messages ?? [])]
    .filter((candidate) => candidate.sessionId === sessionId)
    .sort(compareCanonicalInviteMessages)) {
    const text = message.contentText.trim();
    if (!text) continue;
    const content = canonicalMetadataRecord(message.content);
    const sender = metadataString(content, 'sender')
      || identityById.get(message.senderIdentityId)?.displayName?.trim()
      || null;
    const timeLabel = metadataString(content, 'timeLabel') || null;
    snapshots.push({
      role: message.senderRole,
      sender,
      text,
      timeLabel,
      index: snapshots.length,
    });
  }
  return snapshots;
}

export type CanonicalGroupInviteContext = {
  parentSessionTitle: string | null;
  parentGroupSpaceId: string | null;
  parentSessionParticipants: DesktopBridgeSessionParticipant[];
  parentSessionMessages: DesktopBridgeSessionThreadMessage[];
};

function groupSpaceIdForSession(state: CanonicalSessionState | null, sessionId: string, fallbackGroupSpaceId: string) {
  const currentMetadata = sessionMetadataRecord(state, sessionId);
  return metadataGroupSpaceId(currentMetadata)
    || normalizeStoredGroupSpaceId(fallbackGroupSpaceId);
}

function groupSessionParticipantsForSync(state: CanonicalSessionState | null, sessionId: string) {
  return buildChatGroupBridgeUpdateParticipants({
    participants: canonicalGroupParticipantsForSession(state, sessionId),
    adminIdentityIds: activeGroupAdminIds(state, sessionId),
  });
}

export function canonicalGroupInviteContextForSession(
  state: CanonicalSessionState | null,
  sessionId: string,
  fallbackGroupSpaceId: string,
): CanonicalGroupInviteContext {
  const groupSpaceId = groupSpaceIdForSession(state, sessionId, fallbackGroupSpaceId);
  return {
    parentSessionTitle: canonicalGroupInviteTitleForSession(state, sessionId),
    parentGroupSpaceId: groupSpaceId || null,
    parentSessionParticipants: groupSessionParticipantsForSync(state, sessionId),
    parentSessionMessages: canonicalSessionMessagesForGroupInvite(state, sessionId),
  };
}

export function canonicalGroupSessionSyncContextForSession(
  state: CanonicalSessionState | null,
  sessionId: string,
  fallbackGroupSpaceId: string,
): CanonicalGroupInviteContext {
  const session = state?.sessions.find((candidate) => candidate.id === sessionId);
  const groupSpaceId = groupSpaceIdForSession(state, sessionId, fallbackGroupSpaceId);
  return {
    parentSessionTitle: session?.title?.trim() || 'New session',
    parentGroupSpaceId: groupSpaceId || null,
    parentSessionParticipants: groupSessionParticipantsForSync(state, sessionId),
    parentSessionMessages: [],
  };
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

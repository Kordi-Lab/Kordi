import {
  adminIdentityIdsFromMetadata,
  buildChatGroupCollaborationUpdateParticipants,
} from '@/features/chat/chatCreateFlows';
import { sharedGroupCustomTitle } from '@/features/chat/groupTitle';
import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
  ConversationParticipant,
  DesktopCollaborationSessionParticipant,
  DesktopCollaborationSessionThreadMessage,
  DesktopChatState,
  ParticipantSpaceViewModel,
} from '@/kordi-app/types';

export { canonicalLocalAgentAvatarSeed } from '@/features/canonical/avatarIdentity';
export {
  currentMentionQuery,
  filterMentionTargets,
  insertComposerMention,
  mentionTargetMatchesExactly,
  normalizeMentionSearch,
} from '@/kordi-app/components/composerMentionOptions';
export type { MentionQuery } from '@/kordi-app/components/composerMentionOptions';

export function shouldUseCloudSessionAction(sessionId: string, state: CanonicalSessionState | null = null) {
  const trimmed = sessionId.trim();
  return trimmed.startsWith('session:') || trimmed.startsWith('bridge:cloud:') || sessionMetadataRecord(state, trimmed).cloudSelfAgentSession === true;
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

function isLegacyCollaborationUiMessageToPreserve(message: CanonicalSessionMessage) {
  return message.sourceTransport === 'desktop-bridge-ui'
    && message.senderRole === 'user'
    && optimisticCanonicalMessageStatusIsPreservable(message);
}

function isLegacyCollaborationContactLocalAgentUiMessageToPreserve(message: CanonicalSessionMessage) {
  return message.sourceTransport === 'desktop-chat-ui'
    && message.senderRole === 'user'
    && message.sessionId.startsWith('session:bridge:')
    && optimisticCanonicalMessageStatusIsPreservable(message);
}

function isLegacyCollaborationSessionSyncMessageToPreserve(message: CanonicalSessionMessage) {
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
  return isLegacyCollaborationUiMessageToPreserve(message)
    || isLegacyCollaborationContactLocalAgentUiMessageToPreserve(message)
    || isLegacyCollaborationSessionSyncMessageToPreserve(message);
}

export function mergeCanonicalStatePreservingCollaborationUiMessages(
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

export function stripDerivedCloudUnreadCounts(state: CanonicalSessionState | null): CanonicalSessionState | null {
  if (!state) return state;
  let changed = false;
  const sessions = state.sessions.map((session) => {
    const metadata = canonicalMetadataRecord(session.metadata);
    if (!Object.prototype.hasOwnProperty.call(metadata, 'cloudUnreadCount')) return session;
    changed = true;
    delete metadata.cloudUnreadCount;
    return { ...session, metadata };
  });
  return changed ? { ...state, sessions } : state;
}

export function sessionMetadataRecord(state: CanonicalSessionState | null, sessionId: string) {
  const session = state?.sessions.find((candidate) => candidate.id === sessionId);
  return canonicalMetadataRecord(session?.metadata);
}

export function activeGroupAdminIds(state: CanonicalSessionState | null, sessionId: string) {
  if (!state) return [];
  const creatorIdentityId = canonicalGroupCreatorIdentityId(state, sessionId);
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return creatorIdentityId ? [creatorIdentityId] : [];
  const sessionMetadata = canonicalMetadataRecord(session.metadata);
  const groupSpaceId = metadataGroupSpaceId(sessionMetadata) || sessionId;
  const rootSession = state.sessions.find((candidate) => candidate.id === groupSpaceId) ?? session;
  const rootMetadata = canonicalMetadataRecord(rootSession.metadata);
  const rootRevision = typeof rootMetadata.groupAdminUpdatedAtMs === 'number'
    && Number.isFinite(rootMetadata.groupAdminUpdatedAtMs)
    ? rootMetadata.groupAdminUpdatedAtMs
    : 0;
  const newerReplicatedSession = state.sessions
    .filter((candidate) => {
      if (candidate.id === rootSession.id) return false;
      const metadata = canonicalMetadataRecord(candidate.metadata);
      if ((metadataGroupSpaceId(metadata) || candidate.id) !== groupSpaceId) return false;
      const revision = typeof metadata.groupAdminUpdatedAtMs === 'number'
        && Number.isFinite(metadata.groupAdminUpdatedAtMs)
        ? metadata.groupAdminUpdatedAtMs
        : 0;
      return revision > rootRevision;
    })
    .sort((left, right) => {
      const leftMetadata = canonicalMetadataRecord(left.metadata);
      const rightMetadata = canonicalMetadataRecord(right.metadata);
      const leftRevision = typeof leftMetadata.groupAdminUpdatedAtMs === 'number' ? leftMetadata.groupAdminUpdatedAtMs : 0;
      const rightRevision = typeof rightMetadata.groupAdminUpdatedAtMs === 'number' ? rightMetadata.groupAdminUpdatedAtMs : 0;
      return rightRevision - leftRevision || right.updatedAtMs - left.updatedAtMs;
    })[0];
  const authoritySession = newerReplicatedSession ?? rootSession;
  const metadataAdminIds = adminIdentityIdsFromMetadata(canonicalMetadataRecord(authoritySession.metadata));
  if (metadataAdminIds.length > 0) {
    return [...new Set([creatorIdentityId, ...metadataAdminIds].filter(Boolean))];
  }
  const roleAdminIds = state.participants
    .filter((participant) => (
      participant.sessionId === authoritySession.id
      && participant.state === 'active'
      && participant.role === 'admin'
    ))
    .map((participant) => participant.identityId);
  return [...new Set([
    creatorIdentityId,
    ...roleAdminIds,
  ].map((identityId) => identityId?.trim() ?? '').filter(Boolean))];
}

export function canonicalGroupCreatorIdentityId(state: CanonicalSessionState | null, sessionId: string) {
  if (!state) return '';
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return '';
  const metadata = canonicalMetadataRecord(session.metadata);
  const groupSpaceId = metadataGroupSpaceId(metadata);
  const rootSession = groupSpaceId
    ? state.sessions.find((candidate) => candidate.id === groupSpaceId)
    : null;
  const rootMetadataCreator = rootSession
    ? metadataString(canonicalMetadataRecord(rootSession.metadata), 'groupCreatorIdentityId')
    : '';
  return rootMetadataCreator
    || rootSession?.createdByIdentityId?.trim()
    || metadataString(metadata, 'groupCreatorIdentityId')
    || session.createdByIdentityId?.trim()
    || '';
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
      const metadata = canonicalMetadataRecord(identity.metadata);
      return [{
        id: identity.id,
        name: identity.displayName,
        kind: identity.kind === 'agent' ? 'agent' : 'human',
        role,
        source: identity.source,
        ownerIdentityId: identity.ownerIdentityId,
        sourceHostId: identity.sourceHostId,
        sourceIdentityId: identity.sourceIdentityId,
        humanId: identity.humanId,
        agentId: identity.agentId,
        avatarKey: identity.avatarKey,
        profileImageUrl: identity.profileImageUrl,
        defaultAgentId: metadataString(metadata, 'defaultAgentId'), defaultAgentDisplayName: metadataString(metadata, 'defaultAgentDisplayName'),
        defaultAgentAvatarUrl: metadataString(metadata, 'defaultAgentAvatarUrl'), defaultAgentAvatarSeed: metadataString(metadata, 'defaultAgentAvatarSeed'),
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
  return value.trim().replace(/^(?:group:)+/, '');
}

export function metadataGroupSpaceId(metadata: Record<string, unknown>) {
  return normalizeStoredGroupSpaceId(metadataString(metadata, 'groupId')
    || metadataString(metadata, 'groupSpaceId')
    || metadataString(metadata, 'continuedFromSpaceId'));
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
  return `${actor} changed the ${scope === 'session' ? 'channel' : 'group'} name to ${title.trim()}`;
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

export function canonicalGroupInviteTitleForSession(state: CanonicalSessionState | null, sessionId: string) {
  const session = state?.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return null;
  const metadata = canonicalMetadataRecord(session.metadata);
  const groupSpaceId = metadataGroupSpaceId(metadata) || sessionId;
  const relatedSessions = state?.sessions.filter((candidate) => {
    const candidateMetadata = canonicalMetadataRecord(candidate.metadata);
    return candidate.id === groupSpaceId || metadataGroupSpaceId(candidateMetadata) === groupSpaceId;
  }) ?? [];
  const sharedTitle = sharedGroupCustomTitle(relatedSessions.map((candidate) => {
    const candidateMetadata = canonicalMetadataRecord(candidate.metadata);
    const updatedAtMs = candidateMetadata.groupNameUpdatedAtMs;
    return {
      sessionId: candidate.id,
      groupSpaceId: metadataGroupSpaceId(candidateMetadata),
      customName: metadataString(candidateMetadata, 'customName'),
      groupNameUpdatedAtMs: typeof updatedAtMs === 'number' ? updatedAtMs : null,
    };
  }), groupSpaceId);
  if (sharedTitle) return sharedTitle;

  // Very old group roots stored their shared label in the session title before
  // groupSpaceId/customName existed. Never use a modern child-session title as
  // a group label: that is how "# main" leaked into other members' sidebars.
  const rootSession = relatedSessions.find((candidate) => candidate.id === groupSpaceId);
  const rootMetadata = canonicalMetadataRecord(rootSession?.metadata);
  if (rootSession && !metadataGroupSpaceId(rootMetadata)) {
    return nonGenericGroupInviteTitle(rootSession.title);
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
): DesktopCollaborationSessionThreadMessage[] {
  const identityById = new Map((state?.identities ?? []).map((identity) => [identity.id, identity]));
  const snapshots: DesktopCollaborationSessionThreadMessage[] = [];
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
  parentSessionParticipants: DesktopCollaborationSessionParticipant[];
  parentSessionMessages: DesktopCollaborationSessionThreadMessage[];
};

function groupSpaceIdForSession(state: CanonicalSessionState | null, sessionId: string, fallbackGroupSpaceId: string) {
  const currentMetadata = sessionMetadataRecord(state, sessionId);
  return metadataGroupSpaceId(currentMetadata)
    || normalizeStoredGroupSpaceId(fallbackGroupSpaceId);
}

function groupSessionParticipantsForSync(state: CanonicalSessionState | null, sessionId: string) {
  return buildChatGroupCollaborationUpdateParticipants({
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

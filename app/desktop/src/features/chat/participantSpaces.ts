import type {
  ChatChannel,
  Conversation,
  ConversationParticipant,
  ParticipantSpaceAvatar,
  ParticipantSpaceKind,
  ParticipantSpaceSessionViewModel,
  ParticipantSpaceViewModel,
} from '@/kordi-app/types';
import {
  deterministicGroupParticipantTitle,
  groupParticipantStableKey,
  sharedGroupCustomTitle,
} from './groupTitle';

type ConversationWithTimestamp = Conversation & { _updatedAtMs?: number };

function cleanOptionalText(value?: string | null) {
  return value?.trim() ?? '';
}

function isRawSessionIdText(value: string) {
  const text = value.trim();
  return text.startsWith('session:')
    || text.startsWith('bridge:')
    || text.startsWith('canonical:')
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
}

function safePreviewText(value: string | undefined | null) {
  const text = value?.trim() ?? '';
  return text && !isRawSessionIdText(text) ? text : '';
}

function latestMessageText(conversation: Conversation) {
  const latest = conversation.messages[conversation.messages.length - 1];
  return safePreviewText(latest?.text)
    || safePreviewText(latest?.turn?.assistantText)
    || safePreviewText(conversation.subtitle)
    || safePreviewText(conversation.name);
}

function isBlankSessionLabel(value: string | undefined | null) {
  const text = value?.trim() ?? '';
  return !text || /^(#\s*)?(new chat|new session|untitled session)$/i.test(text);
}

function conversationHasUserContent(conversation: Conversation) {
  if (typeof conversation.canonicalMessageCount === 'number' && conversation.canonicalMessageCount > 0) return true;
  if (conversation.queuedMessages?.length) return true;
  return conversation.messages.some((message) => message.role !== 'system' && message.text.trim().length > 0);
}

export function isBlankParticipantSpaceSession(session: ParticipantSpaceSessionViewModel) {
  return !conversationHasUserContent(session.conversation)
    && isBlankSessionLabel(session.title)
    && isBlankSessionLabel(session.conversation.name);
}

export function isPersistedBlankGroupContinuation(session: ParticipantSpaceSessionViewModel) {
  if (session.conversation.transientDraft || !isBlankParticipantSpaceSession(session)) return false;
  const metadata = metadataRecord(session.conversation.metadata);
  const sessionId = cleanOptionalText(session.canonicalSessionId) || cleanOptionalText(session.id);
  const groupSpaceId = normalizeGroupSpaceId(
    metadataStringValue(metadata, 'groupSpaceId')
      || metadataStringValue(metadata, 'groupId'),
  );
  const continuedFromSessionId = metadataStringValue(metadata, 'continuedFromSessionId');
  const continuedFromSpaceId = metadataStringValue(metadata, 'continuedFromSpaceId');
  return Boolean(continuedFromSessionId || continuedFromSpaceId || (groupSpaceId && groupSpaceId !== sessionId));
}

function blankAgentSessionCollapseKey(session: ParticipantSpaceSessionViewModel) {
  if (conversationHasUserContent(session.conversation) || session.conversation.type !== 'owned-agent') return null;
  const metadata = metadataRecord(session.conversation.metadata);
  const agent = nonSelfAgents(allDisplayParticipants(session.conversation))[0];
  const agentKey = metadataStringValue(metadata, 'agentId')
    || agent?.id
    || agent?.agentId
    || cleanOptionalText(session.title)
    || cleanOptionalText(session.conversation.name);
  return agentKey ? `agent:${agentKey}` : null;
}

function blankSessionCollapseKey(session: ParticipantSpaceSessionViewModel) {
  return blankAgentSessionCollapseKey(session) ?? (isBlankParticipantSpaceSession(session) ? 'generic' : null);
}

function collapseDuplicateBlankSessions(sessions: ParticipantSpaceSessionViewModel[]) {
  const blankKeys = new Set<string>();
  return sessions.filter((session) => {
    const blankKey = blankSessionCollapseKey(session);
    if (!blankKey) return true;
    if (blankKeys.has(blankKey)) return false;
    blankKeys.add(blankKey);
    return true;
  });
}

function conversationTimestamp(conversation: Conversation, fallbackIndex: number) {
  const raw = (conversation as ConversationWithTimestamp)._updatedAtMs;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallbackIndex;
}

function isSelfParticipant(participant: ConversationParticipant) {
  return participant.role === 'self'
    || (participant.source === 'local' && participant.kind === 'human');
}

function participantSortKey(participant: ConversationParticipant) {
  return [participant.kind, participant.id, participant.name].join('\u0000');
}

function isSelfLabel(name: string) {
  return ['me', 'you'].includes(name.trim().toLowerCase());
}

function fallbackParticipantIdentity(conversation: Conversation, name: string, kind: ConversationParticipant['kind'], self: boolean) {
  if (self) {
    const localHumanId = cleanOptionalText(conversation.identity?.localHumanId);
    return {
      id: localHumanId ? `human:${localHumanId}` : `label:${kind}:${name}`,
      humanId: localHumanId || null,
      sourceIdentityId: null,
      sourceHostId: null,
    };
  }

  const remoteHumanId = cleanOptionalText(conversation.identity?.remoteHumanId)
    || (kind === 'human' ? cleanOptionalText(conversation.collaborationTarget?.humanId) : '');
  const remoteAgentId = cleanOptionalText(conversation.identity?.remoteAgentId)
    || (kind === 'agent' ? cleanOptionalText(conversation.collaborationTarget?.agentId) : '');
  const remoteNodeId = cleanOptionalText(conversation.identity?.remoteHumanNodeId)
    || cleanOptionalText(conversation.identity?.remoteAgentNodeId)
    || cleanOptionalText(conversation.collaborationTarget?.nodeId);
  const stableKey = remoteHumanId || remoteAgentId || remoteNodeId;
  return {
    id: stableKey ? `${kind}:${stableKey}` : `label:${kind}:${name}`,
    humanId: remoteHumanId || null,
    agentId: remoteAgentId || null,
    sourceIdentityId: remoteNodeId || null,
    sourceHostId: cleanOptionalText(conversation.collaborationTarget?.hostId) || cleanOptionalText(conversation.identity?.sourceHostId) || null,
  };
}

function fallbackParticipants(conversation: Conversation): ConversationParticipant[] {
  const firstNonSelfName = conversation.participants.find((name) => !isSelfLabel(name));
  return conversation.participants.map((name) => {
    const self = isSelfLabel(name);
    const kind = !self && conversation.type !== 'person' ? 'agent' : 'human';
    const identity = fallbackParticipantIdentity(conversation, name, kind, self);
    const avatarKey = conversation.participantAvatarSeeds?.[name]
      ?? (!self && name === firstNonSelfName ? conversation.avatarSeed ?? null : null);
    const profileImageUrl = conversation.participantProfileImageUrls?.[name]
      ?? (!self && name === firstNonSelfName ? conversation.profileImageUrl ?? null : null);
    const presenceStatus = identity.humanId
      ? conversation.participantPresenceStatuses?.[identity.humanId] ?? null
      : null;
    return {
      ...identity,
      name,
      kind,
      role: self ? 'self' : kind === 'agent' ? 'delegate' : 'participant',
      source: (self || (conversation.type === 'owned-agent' && kind === 'agent')) ? 'local' : identity.sourceHostId ? 'collaboration' : null,
      avatarKey,
      profileImageUrl,
      presenceStatus,
    } satisfies ConversationParticipant;
  });
}

function nonSelfParticipants(conversation: Conversation) {
  const canonical = conversation.canonicalParticipants ?? [];
  if (canonical.length > 0) {
    return canonical.filter((participant) => !isSelfParticipant(participant));
  }
  return fallbackParticipants(conversation).filter((participant) => !isSelfParticipant(participant));
}

function allDisplayParticipants(conversation: Conversation): ConversationParticipant[] {
  const canonical = conversation.canonicalParticipants ?? [];
  return canonical.length > 0 ? canonical : fallbackParticipants(conversation);
}

function nonSelfHumans(participants: ConversationParticipant[]) {
  return participants.filter((participant) => !isSelfParticipant(participant) && participant.kind === 'human');
}

function nonSelfAgents(participants: ConversationParticipant[]) {
  return participants.filter((participant) => !isSelfParticipant(participant) && participant.kind === 'agent');
}

function selfParticipant(participants: ConversationParticipant[]) {
  return participants.find((participant) => isSelfParticipant(participant));
}

function spaceKindForConversation(conversation: Conversation, nonSelf: ConversationParticipant[]): ParticipantSpaceKind {
  // A fork of a canonical (group/contact) session is always a private
  // continuation — even if its stored participant list inherited
  // multiple humans from the source, we never want it to render as a
  // separate group conversation in the sidebar. Defensive override
  // covers historical forks created before the participant filter
  // landed too.
  const forkParent = conversation.forkedFromSessionId?.trim() ?? '';
  if (forkParent.startsWith('session:')) {
    return 'self';
  }
  const humanCount = nonSelfHumans(nonSelf).length;
  if (conversation.participantSpaceId || humanCount > 1) {
    return 'group';
  }
  if (humanCount === 1) {
    return 'direct-human';
  }
  if (nonSelfAgents(nonSelf).length > 0 || conversation.type === 'external-agent' || conversation.type === 'owned-agent') {
    return 'self';
  }
  return 'self';
}

function primaryParticipantForKind(kind: ParticipantSpaceKind, participants: ConversationParticipant[]) {
  if (kind === 'self') return selfParticipant(participants) ?? participants[0];
  if (kind === 'direct-human') return nonSelfHumans(participants)[0] ?? participants.find((participant) => !isSelfParticipant(participant));
  if (kind === 'direct-agent') return nonSelfAgents(participants)[0] ?? participants.find((participant) => !isSelfParticipant(participant));
  return participants.find((participant) => !isSelfParticipant(participant)) ?? participants[0];
}

function normalizeGroupSpaceId(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith('group:') ? trimmed.slice('group:'.length) : trimmed;
}

function metadataStringValue(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'string' ? value.trim() : '';
}

function metadataStringArrayValue(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function metadataNumberValue(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function groupSpaceIdForConversation(conversation: Conversation) {
  const metadata = metadataRecord(conversation.metadata);
  const continuationSpaceId = metadataStringValue(metadata, 'continuedFromSpaceId');
  if (continuationSpaceId) return normalizeGroupSpaceId(continuationSpaceId);
  const explicit = cleanOptionalText(conversation.participantSpaceId);
  if (explicit) return normalizeGroupSpaceId(explicit);
  return normalizeGroupSpaceId(
    metadataStringValue(metadata, 'groupSpaceId')
    || metadataStringValue(metadata, 'groupId'),
  );
}

function groupParticipantKey(conversation: Conversation) {
  return allDisplayParticipants(conversation)
    .filter((participant) => participant.kind === 'human')
    .map((participant) => participant.id.trim())
    .filter(Boolean)
    .sort()
    .join('+');
}

function nonGenericGroupTitle(value: string | undefined | null) {
  const title = safePreviewText(value);
  return isBlankSessionLabel(title) ? '' : title;
}

function groupHasCustomName(conversation: Conversation) {
  return Boolean(nonGenericGroupTitle(metadataStringValue(metadataRecord(conversation.metadata), 'customName')));
}

function genericLegacyCollaborationGroupContinuation(conversation: Conversation) {
  const metadata = metadataRecord(conversation.metadata);
  if (metadataStringValue(metadata, 'source') !== 'bridge-session-thread') return false;
  if (groupHasCustomName(conversation)) return false;
  const ownSessionId = (conversation.canonicalSessionId || conversation.id).trim();
  const explicitGroupId = normalizeGroupSpaceId(
    metadataStringValue(metadata, 'groupSpaceId')
    || metadataStringValue(metadata, 'groupId'),
  );
  return Boolean(ownSessionId && explicitGroupId === ownSessionId);
}

function cloudGroupParticipantKey(conversation: Conversation) {
  const humans = allDisplayParticipants(conversation).filter((participant) => participant.kind === 'human');
  if (humans.length < 2) return '';
  if (!humans.every((participant) => participant.sourceHostId === 'cloud' || cleanOptionalText(participant.humanId).startsWith('acct_') || cleanOptionalText(participant.sourceIdentityId).startsWith('acct_'))) {
    return '';
  }
  return humans
    .map((participant) => cleanOptionalText(participant.humanId) || cleanOptionalText(participant.sourceIdentityId) || cleanOptionalText(participant.id))
    .filter(Boolean)
    .sort()
    .join('+');
}

function spaceIdForConversation(
  kind: ParticipantSpaceKind,
  primary: ConversationParticipant | undefined,
  conversation: Conversation,
  legacyCloudGroupAliasByExplicitId: ReadonlyMap<string, string> = new Map(),
) {
  if (kind === 'self') return 'self:local';
  if (kind === 'group') {
    const explicit = groupSpaceIdForConversation(conversation);
    if (explicit) return legacyCloudGroupAliasByExplicitId.get(explicit) ?? `group:${explicit}`;
    const cloudParticipantKey = cloudGroupParticipantKey(conversation);
    if (cloudParticipantKey) return `group:cloud:${cloudParticipantKey}`;
    const participantKey = nonSelfParticipants(conversation)
      .map((participant) => participant.id)
      .sort()
      .join('+');
    return `group:${participantKey || conversation.canonicalSessionId || conversation.id}`;
  }
  return `${kind}:${primary?.id || conversation.canonicalSessionId || conversation.id}`;
}

function avatarForParticipant(participant: ConversationParticipant): ParticipantSpaceAvatar {
  return {
    kind: participant.kind === 'agent' ? 'agent' : 'human',
    seed: participant.avatarKey || participant.agentId || participant.humanId || participant.id || participant.name,
    imageUrl: participant.profileImageUrl ?? null,
    presenceStatus: participant.presenceStatus ?? null,
  };
}

function buildSession(conversation: Conversation, updatedAtMs: number): ParticipantSpaceSessionViewModel {
  return {
    id: conversation.id,
    canonicalSessionId: conversation.canonicalSessionId,
    title: conversation.name,
    preview: latestMessageText(conversation),
    unread: Math.max(0, conversation.unread ?? 0),
    updatedAtLabel: conversation.updatedAtLabel,
    updatedAtMs,
    participantCount: Math.max(1, conversation.canonicalParticipantCount ?? allDisplayParticipants(conversation).length),
    statusIndicator: conversation.statusIndicator,
    conversation,
    forkedFromSessionId: conversation.forkedFromSessionId ?? null,
    forkedFromMessageId: conversation.forkedFromMessageId ?? null,
  };
}

function addUniqueParticipants(target: ConversationParticipant[], participants: ConversationParticipant[]) {
  for (const participant of participants) {
    const existingIndex = target.findIndex((current) => current.id === participant.id);
    if (existingIndex === -1) {
      target.push(participant);
      continue;
    }
    const existing = target[existingIndex];
    target[existingIndex] = {
      ...existing,
      role: existing.role === 'self' || participant.role !== 'admin' ? existing.role : 'admin',
      avatarKey: existing.avatarKey || participant.avatarKey,
      publicName: existing.publicName || participant.publicName,
      profileImageUrl: existing.profileImageUrl ?? participant.profileImageUrl ?? null,
      humanId: existing.humanId || participant.humanId,
      sourceIdentityId: existing.sourceIdentityId || participant.sourceIdentityId,
      sourceHostId: existing.sourceHostId || participant.sourceHostId,
      presenceStatus: existing.presenceStatus || participant.presenceStatus,
    };
  }
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function customGroupTitle(sessions: ParticipantSpaceSessionViewModel[], groupSpaceId?: string | null) {
  return sharedGroupCustomTitle(sessions.map((session) => {
    const metadata = metadataRecord(session.conversation.metadata);
    return {
      sessionId: cleanOptionalText(session.canonicalSessionId) || cleanOptionalText(session.id),
      groupSpaceId: metadataStringValue(metadata, 'groupSpaceId') || metadataStringValue(metadata, 'groupId'),
      customName: metadataStringValue(metadata, 'customName'),
      groupNameUpdatedAtMs: metadataNumberValue(metadata, 'groupNameUpdatedAtMs'),
    };
  }), groupSpaceId);
}

export function participantSpaceCustomGroupTitle(space: ParticipantSpaceViewModel) {
  if (space.kind !== 'group') return '';
  return customGroupTitle(space.sessions, normalizeGroupSpaceId(space.id));
}

export const SELF_PARTICIPANT_SPACE_TITLE = 'My chats';

function spaceTitle(
  kind: ParticipantSpaceKind,
  participants: ConversationParticipant[],
  sessions: ParticipantSpaceSessionViewModel[],
  groupSpaceId?: string | null,
  groupCreatorIdentityId?: string | null,
) {
  const latestSession = sessions[0];
  if (kind === 'self') return SELF_PARTICIPANT_SPACE_TITLE;
  if (kind === 'group') {
    return customGroupTitle(sessions, groupSpaceId)
      || deterministicGroupParticipantTitle(participants, groupCreatorIdentityId)
      || safePreviewText(latestSession?.conversation.name)
      || 'Group';
  }
  return primaryParticipantForKind(kind, participants)?.name || safePreviewText(latestSession?.conversation.name) || 'Chat';
}

function avatarParticipantStableKey(participant: ConversationParticipant) {
  return groupParticipantStableKey(participant);
}

function avatarParticipants(kind: ParticipantSpaceKind, participants: ConversationParticipant[]) {
  if (kind === 'self') {
    const primary = selfParticipant(participants) ?? participants.find((participant) => participant.kind === 'human') ?? participants[0];
    return primary ? [primary] : [];
  }
  if (kind === 'group') {
    return participants
      .filter((participant) => participant.kind === 'human')
      .sort((left, right) => avatarParticipantStableKey(left).localeCompare(avatarParticipantStableKey(right)))
      .slice(0, 3);
  }
  const primary = primaryParticipantForKind(kind, participants);
  return primary ? [primary] : [];
}

export function buildParticipantSpaces(conversations: Conversation[]): ParticipantSpaceViewModel[] {
  const cloudRootIdsByParticipantKey = new Map<string, Set<string>>();
  for (const conversation of conversations) {
    const nonSelf = nonSelfParticipants(conversation)
      .sort((left, right) => participantSortKey(left).localeCompare(participantSortKey(right)));
    if (spaceKindForConversation(conversation, nonSelf) !== 'group') continue;
    const participantKey = cloudGroupParticipantKey(conversation);
    const explicitGroupId = groupSpaceIdForConversation(conversation);
    const ownSessionId = cleanOptionalText(conversation.canonicalSessionId) || cleanOptionalText(conversation.id);
    if (!participantKey || !explicitGroupId || explicitGroupId !== ownSessionId) continue;
    const rootIds = cloudRootIdsByParticipantKey.get(participantKey) ?? new Set<string>();
    rootIds.add(explicitGroupId);
    cloudRootIdsByParticipantKey.set(participantKey, rootIds);
  }
  const legacyCloudGroupAliasByExplicitId = new Map<string, string>();
  for (const [participantKey, rootIds] of cloudRootIdsByParticipantKey) {
    if (rootIds.size < 2) continue;
    const aliasId = `group:cloud:${participantKey}`;
    for (const rootId of rootIds) legacyCloudGroupAliasByExplicitId.set(rootId, aliasId);
  }

  const namedGroupIdByParticipantKey = new Map<string, string | null>();
  for (const conversation of conversations) {
    const nonSelf = nonSelfParticipants(conversation)
      .sort((left, right) => participantSortKey(left).localeCompare(participantSortKey(right)));
    const displayParticipants = allDisplayParticipants(conversation);
    const kind = spaceKindForConversation(conversation, nonSelf);
    if (kind !== 'group' || !groupHasCustomName(conversation)) continue;
    const primary = primaryParticipantForKind(kind, displayParticipants);
    const id = spaceIdForConversation(kind, primary, conversation, legacyCloudGroupAliasByExplicitId);
    const participantKey = groupParticipantKey(conversation);
    if (!participantKey) continue;
    const existing = namedGroupIdByParticipantKey.get(participantKey);
    namedGroupIdByParticipantKey.set(participantKey, existing && existing !== id ? null : id);
  }

  const groups = new Map<string, {
    kind: ParticipantSpaceKind;
    participants: ConversationParticipant[];
    sessions: ParticipantSpaceSessionViewModel[];
  }>();

  conversations.forEach((conversation, index) => {
    const nonSelf = nonSelfParticipants(conversation)
      .sort((left, right) => participantSortKey(left).localeCompare(participantSortKey(right)));
    const displayParticipants = allDisplayParticipants(conversation);
    const kind = spaceKindForConversation(conversation, nonSelf);
    const primary = primaryParticipantForKind(kind, displayParticipants);
    const baseId = spaceIdForConversation(kind, primary, conversation, legacyCloudGroupAliasByExplicitId);
    const participantKey = kind === 'group' ? groupParticipantKey(conversation) : '';
    const aliasId = kind === 'group' && genericLegacyCollaborationGroupContinuation(conversation) && participantKey
      ? namedGroupIdByParticipantKey.get(participantKey)
      : null;
    const id = aliasId || baseId;
    const updatedAtMs = conversationTimestamp(conversation, conversations.length - index);
    const session = buildSession(conversation, updatedAtMs);
    const existing = groups.get(id);
    if (existing) {
      existing.sessions.push(session);
      addUniqueParticipants(existing.participants, displayParticipants);
      return;
    }
    groups.set(id, { kind, participants: [...displayParticipants], sessions: [session] });
  });

  return [...groups.entries()]
    .map(([id, group]) => {
      const sortedSessions = group.sessions.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      const membershipSessionIds = group.kind === 'group'
        ? [...new Set(sortedSessions
          .filter((session) => !session.conversation.transientDraft)
          .map((session) => cleanOptionalText(session.canonicalSessionId) || cleanOptionalText(session.id))
          .filter(Boolean))]
        : undefined;
      const groupSpaceId = group.kind === 'group' ? normalizeGroupSpaceId(id) : '';
      const groupRootSession = group.kind === 'group'
        ? sortedSessions.find((session) => (
          (cleanOptionalText(session.canonicalSessionId) || cleanOptionalText(session.id)) === groupSpaceId
        )) ?? sortedSessions[sortedSessions.length - 1]
        : undefined;
      const groupCreatorIdentityId = group.kind === 'group'
        ? (() => {
          const rootMetadata = metadataRecord(groupRootSession?.conversation.metadata);
          return metadataStringValue(rootMetadata, 'groupCreatorIdentityId')
            || cleanOptionalText(groupRootSession?.conversation.canonicalCreatedByIdentityId)
            || cleanOptionalText(sortedSessions[sortedSessions.length - 1]?.conversation.canonicalCreatedByIdentityId)
            || null;
        })()
        : null;
      const groupCreatedAtMs = group.kind === 'group'
        ? (() => {
          const rootCreatedAtMs = groupRootSession?.conversation.canonicalCreatedAtMs;
          if (typeof rootCreatedAtMs === 'number' && Number.isFinite(rootCreatedAtMs) && rootCreatedAtMs > 0) {
            return rootCreatedAtMs;
          }
          const knownCreationTimes = sortedSessions
            .map((session) => session.conversation.canonicalCreatedAtMs)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
          return knownCreationTimes.length > 0 ? Math.min(...knownCreationTimes) : null;
        })()
        : null;
      const groupAdminIdentityIds = group.kind === 'group'
        ? (() => {
          const rootRevision = metadataNumberValue(
            metadataRecord(groupRootSession?.conversation.metadata),
            'groupAdminUpdatedAtMs',
          );
          const newerReplicatedAdminSource = [...sortedSessions]
            .filter((session) => (
              session !== groupRootSession
              && metadataNumberValue(
                metadataRecord(session.conversation.metadata),
                'groupAdminUpdatedAtMs',
              ) > rootRevision
            ))
            .sort((left, right) => {
            const leftRevision = metadataNumberValue(metadataRecord(left.conversation.metadata), 'groupAdminUpdatedAtMs');
            const rightRevision = metadataNumberValue(metadataRecord(right.conversation.metadata), 'groupAdminUpdatedAtMs');
            if (leftRevision !== rightRevision) return rightRevision - leftRevision;
            return right.updatedAtMs - left.updatedAtMs;
            })[0];
          const adminSource = newerReplicatedAdminSource ?? groupRootSession;
          const metadataAdmins = metadataStringArrayValue(
            metadataRecord(adminSource?.conversation.metadata),
            'adminIdentityIds',
          );
          const authorityParticipants = adminSource?.conversation.canonicalParticipants ?? group.participants;
          const roleAdmins = authorityParticipants
            .filter((participant) => participant.role === 'admin')
            .map((participant) => participant.id);
          return [...new Set([
            groupCreatorIdentityId,
            ...(metadataAdmins.length > 0 ? metadataAdmins : roleAdmins),
          ].map((identityId) => cleanOptionalText(identityId)).filter(Boolean))];
        })()
        : undefined;
      const sessions = collapseDuplicateBlankSessions(
        group.kind === 'group'
          ? sortedSessions.filter((session) => !isPersistedBlankGroupContinuation(session))
          : sortedSessions,
      );
      const latest = sessions[0];
      return {
        id,
        kind: group.kind,
        title: spaceTitle(group.kind, group.participants, sessions, groupSpaceId, groupCreatorIdentityId),
        participants: group.participants,
        participantCount: group.participants.length,
        sessionCount: sessions.length,
        unread: sessions.reduce((sum, session) => sum + session.unread, 0),
        updatedAtLabel: latest?.updatedAtLabel,
        updatedAtMs: latest?.updatedAtMs ?? 0,
        createdAtMs: groupCreatedAtMs,
        preview: latest?.preview ?? '',
        avatarStack: avatarParticipants(group.kind, group.participants).map(avatarForParticipant),
        sessions,
        groupCreatorIdentityId,
        groupAdminIdentityIds,
        membershipSessionIds,
      } satisfies ParticipantSpaceViewModel;
    })
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.title.localeCompare(right.title));
}

export function spaceMatchesChannel(space: ParticipantSpaceViewModel, channel: ChatChannel) {
  if (channel === 'agent') return space.kind === 'self' || space.kind === 'direct-agent';
  return space.kind === 'direct-human' || space.kind === 'group';
}

export type AgentIdentity = {
  name: string;
  avatarSeed: string;
  profileImageUrl: string | null;
};

export function primaryAgentForConversation(conversation: Conversation): AgentIdentity | null {
  const canonical = conversation.canonicalParticipants ?? [];
  const list = canonical.length > 0 ? canonical : fallbackParticipants(conversation);
  const agent = list.find((participant) => !isSelfParticipant(participant) && participant.kind === 'agent');
  if (!agent) return null;
  return {
    name: agent.name,
    avatarSeed: agent.avatarKey || agent.id || agent.name,
    profileImageUrl: agent.profileImageUrl ?? null,
  };
}

export function ensureSelfParticipantSpace(
  spaces: ParticipantSpaceViewModel[],
  options: { avatarSeed?: string | null; profileImageUrl?: string | null } = {},
) {
  if (spaces.some((space) => space.kind === 'self')) return spaces;

  const avatarSeed = cleanOptionalText(options.avatarSeed) || 'me';
  const selfParticipant: ConversationParticipant = {
    id: 'human:self',
    name: 'Me',
    kind: 'human',
    role: 'self',
    source: 'local',
    avatarKey: avatarSeed,
    profileImageUrl: cleanOptionalText(options.profileImageUrl) || null,
  };

  const selfSpace: ParticipantSpaceViewModel = {
    id: 'self:local',
    kind: 'self',
    title: SELF_PARTICIPANT_SPACE_TITLE,
    participants: [selfParticipant],
    participantCount: 1,
    sessionCount: 0,
    unread: 0,
    updatedAtMs: 0,
    preview: '',
    avatarStack: [{ kind: 'human', seed: avatarSeed, imageUrl: selfParticipant.profileImageUrl ?? null }],
    sessions: [],
  };

  return [...spaces, selfSpace];
}

export function filterParticipantSpaces(
  spaces: ParticipantSpaceViewModel[],
  query: string,
  channel: ChatChannel,
) {
  const normalized = query.trim().toLowerCase();
  return spaces.filter((space) => {
    if (!spaceMatchesChannel(space, channel)) return false;
    if (!normalized) return true;
    const haystack = [
      space.title,
      space.preview,
      ...space.participants.map((participant) => participant.name),
      ...space.sessions.flatMap((session) => [session.title, session.preview]),
    ].join(' ').toLowerCase();
    return haystack.includes(normalized);
  });
}

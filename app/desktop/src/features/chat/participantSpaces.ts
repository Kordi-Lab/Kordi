import type {
  Conversation,
  ConversationParticipant,
  ParticipantSpaceAvatar,
  ParticipantSpaceKind,
  ParticipantSpaceSessionViewModel,
  ParticipantSpaceViewModel,
} from '@/kordi-app/types';

type ConversationWithTimestamp = Conversation & { _updatedAtMs?: number };

function latestMessageText(conversation: Conversation) {
  return conversation.messages[conversation.messages.length - 1]?.text?.trim()
    || conversation.subtitle.trim()
    || conversation.name.trim();
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

function fallbackParticipants(conversation: Conversation) {
  const firstNonSelfName = conversation.participants.find((name) => !isSelfLabel(name));
  return conversation.participants.map((name) => {
    const self = isSelfLabel(name);
    const kind = !self && conversation.type !== 'person' ? 'agent' : 'human';
    const avatarKey = conversation.participantAvatarSeeds?.[name]
      ?? (!self && name === firstNonSelfName ? conversation.avatarSeed ?? null : null);
    return {
      id: `label:${kind}:${name}`,
      name,
      kind,
      role: self ? 'self' : kind === 'agent' ? 'delegate' : 'participant',
      source: (self || (conversation.type === 'owned-agent' && kind === 'agent')) ? 'local' : null,
      avatarKey,
      profileImageUrl: !self && name === firstNonSelfName ? conversation.profileImageUrl ?? null : null,
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

function allDisplayParticipants(conversation: Conversation) {
  const canonical = conversation.canonicalParticipants ?? [];
  return canonical.length > 0 ? canonical : fallbackParticipants(conversation);
}

function spaceKindForConversation(conversation: Conversation, nonSelf: ConversationParticipant[]): ParticipantSpaceKind {
  if (conversation.participantSpaceId || nonSelf.length > 1) {
    return 'group';
  }
  const primary = nonSelf[0];
  if (primary?.kind === 'agent' || conversation.type === 'external-agent' || conversation.type === 'owned-agent') {
    return 'direct-agent';
  }
  return 'direct-human';
}

function spaceIdForConversation(kind: ParticipantSpaceKind, primary: ConversationParticipant | undefined, conversation: Conversation) {
  if (kind === 'group') {
    const explicit = conversation.participantSpaceId?.trim();
    if (explicit) return `group:${explicit}`;
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
  };
}

function addUniqueParticipants(target: ConversationParticipant[], participants: ConversationParticipant[]) {
  for (const participant of participants) {
    if (!target.some((current) => current.id === participant.id)) {
      target.push(participant);
    }
  }
}

function spaceTitle(kind: ParticipantSpaceKind, participants: ConversationParticipant[], latestSession: ParticipantSpaceSessionViewModel | undefined) {
  const nonSelf = participants.filter((participant) => !isSelfParticipant(participant));
  if (kind === 'group') {
    return latestSession?.conversation.name || nonSelf.map((participant) => participant.name).join(', ') || 'Group';
  }
  return nonSelf[0]?.name || latestSession?.conversation.name || 'Chat';
}

function avatarParticipants(kind: ParticipantSpaceKind, participants: ConversationParticipant[]) {
  if (kind === 'group') return participants;
  const primary = participants.find((participant) => !isSelfParticipant(participant)) ?? participants[0];
  return primary ? [primary] : [];
}

export function buildParticipantSpaces(conversations: Conversation[]): ParticipantSpaceViewModel[] {
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
    const primary = nonSelf[0] ?? displayParticipants[0];
    const id = spaceIdForConversation(kind, primary, conversation);
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
      const sessions = group.sessions.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      const latest = sessions[0];
      return {
        id,
        kind: group.kind,
        title: spaceTitle(group.kind, group.participants, latest),
        participants: group.participants,
        participantCount: group.participants.length,
        sessionCount: sessions.length,
        unread: sessions.reduce((sum, session) => sum + session.unread, 0),
        updatedAtLabel: latest?.updatedAtLabel,
        updatedAtMs: latest?.updatedAtMs ?? 0,
        preview: latest?.preview ?? '',
        avatarStack: avatarParticipants(group.kind, group.participants).slice(0, 4).map(avatarForParticipant),
        sessions,
      } satisfies ParticipantSpaceViewModel;
    })
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.title.localeCompare(right.title));
}

export function filterParticipantSpaces(spaces: ParticipantSpaceViewModel[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return spaces;
  return spaces.filter((space) => {
    const haystack = [
      space.title,
      space.preview,
      ...space.participants.map((participant) => participant.name),
      ...space.sessions.flatMap((session) => [session.title, session.preview]),
    ].join(' ').toLowerCase();
    return haystack.includes(normalized);
  });
}

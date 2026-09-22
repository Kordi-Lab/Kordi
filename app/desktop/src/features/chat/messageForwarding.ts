import type { Contact, Conversation, ParticipantSpaceViewModel } from '@/kordi-app/types';
import { buildParticipantSpaces, isPersistedBlankGroupContinuationConversation } from './participantSpaces';
import { cloudCollaborationConversationId } from '@/features/collaboration/conversationIds';
import { isCloudContact } from '@/features/cloud/cloudContactMapping';
import { safePreviewText } from './participantConversationState';
import { conversationChatKindLabel } from './sessionKindLabels';

import {
  forwardMessageAction,
  type ForwardMessageSource,
} from './messageActionMetadata';

export type ForwardDestination = {
  id: string;
  conversationId: string;
  label: string;
  subtitle: string;
  kind?: 'person' | 'group' | 'agent';
  parentLabel?: string;
  identityLabel?: string;
  searchText?: string;
  updatedAtMs?: number;
  updatedAtLabel?: string;
  profileImageUrl?: string | null;
  contactId?: string;
};

export function forwardDestinationPath(destination: ForwardDestination) {
  const path = [destination.parentLabel, destination.label].filter(Boolean).join(' › ');
  return destination.identityLabel ? `${path} · ${destination.identityLabel}` : path;
}

export function filterForwardDestinations(destinations: ForwardDestination[], query: string, kind = 'all') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return destinations.filter((destination) => {
    if (kind !== 'all' && destination.kind !== kind) return false;
    const text = [destination.label, destination.subtitle, destination.parentLabel, destination.identityLabel, destination.searchText].filter(Boolean).join(' ').toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function forwardContactConversationId(contact: Contact): string | null {
  if (!isCloudContact(contact) || contact.contactStatus !== 'accepted' || contact.entityType !== 'user' || contact.systemContact) return null;
  const peerId = contact.sourceParticipantId?.trim();
  return peerId ? cloudCollaborationConversationId(peerId, 'person') : null;
}

export function buildForwardDestinations(
  conversations: Conversation[],
  excludedConversationId?: string | null,
  contacts: Contact[] = [],
): ForwardDestination[] {
  const spaces = buildParticipantSpaces(conversations);
  const spaceByConversation = new Map<string, ParticipantSpaceViewModel>();
  const spaceById = new Map<string, ParticipantSpaceViewModel>();
  for (const space of spaces) {
    spaceById.set(space.id, space);
    spaceById.set(space.id.replace(/^group:/, ''), space);
    for (const session of space.sessions) spaceByConversation.set(session.id, space);
  }
  const destinations: ForwardDestination[] = [];
  const seen = new Set<string>();
  for (const conversation of conversations) {
    const id = conversation.canonicalSessionId?.trim() || conversation.id;
    if (!id || id === excludedConversationId || conversation.id === excludedConversationId || conversation.transientDraft || conversation.agentSubsessionId || isPersistedBlankGroupContinuationConversation(conversation) || seen.has(id)) continue;
    seen.add(id);
    const space = spaceByConversation.get(conversation.id);
    const kindLabel = conversationChatKindLabel(conversation);
    const kind = kindLabel === 'Agent chat' || kindLabel === 'Forked chat' ? 'agent' : kindLabel === 'Person chat' ? 'person' : 'group';
    const label = safePreviewText(conversation.name) || 'Untitled chat';
    const metadata = conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata as Record<string, unknown> : {};
    const parentSpace = typeof metadata.parentGroupSpaceId === 'string' ? spaceById.get(metadata.parentGroupSpaceId) : null;
    const participants = conversation.canonicalParticipants ?? space?.participants ?? [];
    const peer = participants.find((participant) => participant.role !== 'self' && !(participant.source === 'local' && participant.kind === 'human') && participant.kind === (kind === 'agent' ? 'agent' : 'human'));
    const parentTitle = safePreviewText(parentSpace?.title) || (space?.kind === 'group' ? safePreviewText(space.title) : kind === 'agent' ? safePreviewText(peer?.name) : '');
    destinations.push({
      id, conversationId: conversation.id, label, kind,
      subtitle: kind === 'person' ? 'Direct message' : kind === 'agent' ? 'Agent chat' : kindLabel,
      parentLabel: parentTitle !== label ? parentTitle : '',
      identityLabel: kind === 'person' && peer?.kordiId ? `@${peer.kordiId}` : '',
      searchText: participants.flatMap((participant) => [participant.name, participant.publicName, participant.kordiId]).filter(Boolean).join(' '),
      updatedAtMs: Number.isFinite(conversation._updatedAtMs) ? Math.max(0, conversation._updatedAtMs!) : 0,
      updatedAtLabel: conversation.updatedAtLabel,
      profileImageUrl: conversation.profileImageUrl ?? (kind === 'person' ? peer?.profileImageUrl : null),
    });
  }
  const byConversationId = new Map(destinations.map((destination) => [destination.conversationId, destination]));
  for (const contact of contacts) {
    const conversationId = forwardContactConversationId(contact);
    if (!conversationId || conversationId === excludedConversationId) continue;
    const existing = byConversationId.get(conversationId);
    const identityLabel = contact.subtitle?.startsWith('@') ? contact.subtitle : '';
    if (existing) {
      existing.identityLabel ||= identityLabel;
      existing.searchText = [existing.searchText, contact.name, identityLabel].join(' ');
      continue;
    }
    const destination: ForwardDestination = {
      id: conversationId, conversationId, contactId: contact.id, label: contact.name,
      kind: 'person', subtitle: 'Direct message', identityLabel,
      searchText: [contact.name, identityLabel].join(' '), updatedAtMs: 0,
      profileImageUrl: contact.profileImageUrl,
    };
    destinations.push(destination);
    byConversationId.set(conversationId, destination);
  }
  return destinations.sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0));
}


export function createForwardedMessageDraft({
  source,
  caption,
}: {
  source: ForwardMessageSource;
  caption?: string;
  destinationSessionId: string;
}) {
  const text = caption?.trim()
    || (source.attachmentOnly ? '' : source.textPreview)
    || (source.attachments.length === 0
      ? `${source.attachmentCount} attachment${source.attachmentCount === 1 ? '' : 's'}`
      : '');
  const messageAction = forwardMessageAction(source);
  return {
    text,
    attachments: source.attachments.map((attachment) => ({ ...attachment })),
    voiceMessage: source.voiceMessage ?? null,
    forwardedFrom: messageAction.source,
    messageAction,
  };
}

export function createForwardedMessageDrafts({
  sources,
  caption,
}: {
  sources: ForwardMessageSource[];
  caption?: string;
}) {
  return sources.map((source, index) => createForwardedMessageDraft({
    source,
    caption: sources.length === 1 && index === 0 ? caption : '',
    destinationSessionId: source.sourceSessionId,
  }));
}

export function orderedForwardSourcesForMessageIds(
  orderedMessageIds: string[],
  sourcesByMessageId: ReadonlyMap<string, ForwardMessageSource>,
): ForwardMessageSource[] {
  const result: ForwardMessageSource[] = [];
  orderedMessageIds.forEach((messageId) => {
    const source = sourcesByMessageId.get(messageId);
    if (source) result.push(source);
  });
  return result;
}

export function revealForwardedMessageInDestination({
  destinationConversationId,
  forwardedMessageId,
  setActiveConversationId,
  revealMessage,
  revealLatest,
  defer = (callback) => window.setTimeout(callback, 80),
}: {
  destinationConversationId: string;
  forwardedMessageId?: string | null;
  setActiveConversationId: (conversationId: string) => void;
  revealMessage: (messageId: string) => boolean | void;
  revealLatest?: () => boolean | void;
  defer?: (callback: () => void) => void;
}) {
  setActiveConversationId(destinationConversationId);
  if (forwardedMessageId?.trim()) {
    defer(() => { revealMessage(forwardedMessageId); });
    return;
  }
  revealLatest?.();
}

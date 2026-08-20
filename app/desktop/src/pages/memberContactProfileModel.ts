import type { CSSProperties } from 'react';

import type { CloudAccount } from '@/features/cloud/authClient';
import { canonicalAvatarImageSource } from '@/features/cloud/canonicalAvatar';
import { directSessionId } from '@/features/cloud/chatSyncMapping';
import type {
  Contact,
  Conversation,
  ConversationParticipant,
} from '@/kordi-app/types';

function memberStableId(member: ConversationParticipant) {
  return member.humanId?.trim()
    || member.sourceIdentityId?.trim()
    || member.id.trim();
}

function contactStableId(contact: Contact) {
  return contact.sourceHumanId?.trim()
    || contact.sourceParticipantId?.trim()
    || (contact.id.startsWith('cloud:') ? contact.id.slice('cloud:'.length).trim() : '')
    || contact.id.trim();
}

export function contactForGroupMember(
  contacts: Contact[],
  member: ConversationParticipant,
) {
  const memberIds = new Set([
    member.id,
    memberStableId(member),
    member.humanId?.trim(),
    member.sourceIdentityId?.trim(),
    member.id.startsWith('human:') ? member.id.slice('human:'.length).trim() : '',
  ].filter(Boolean));
  return contacts.find((contact) => [
    contact.id,
    contactStableId(contact),
    contact.sourceParticipantId?.trim(),
    contact.sourceHumanId?.trim(),
    contact.id.startsWith('cloud:') ? contact.id.slice('cloud:'.length).trim() : '',
  ].some((identityId) => Boolean(identityId && memberIds.has(identityId)))) ?? null;
}

export function groupMemberAccountId(
  member: ConversationParticipant,
  contact: Contact | null,
) {
  const candidates = [
    contact?.sourceParticipantId,
    contact?.sourceHumanId,
    member.humanId,
    member.sourceIdentityId,
    member.id.startsWith('human:') ? member.id.slice('human:'.length) : '',
  ];
  return candidates
    .map((value) => value?.trim() ?? '')
    .find((value) => value.startsWith('acct_')) ?? '';
}

export type ContactProfileSharedSummary = {
  photos: number;
  videos: number;
  files: number;
  links: number;
  commonGroups: number;
};

const VIDEO_FILE_EXTENSION = /\.(?:avi|m4v|mkv|mov|mp4|webm)$/iu;

function attachmentIsVideo(attachment: NonNullable<Conversation['messages'][number]['attachments']>[number]) {
  return attachment.mimeType?.trim().toLowerCase().startsWith('video/') === true
    || VIDEO_FILE_EXTENSION.test(attachment.name.trim());
}

export function contactProfileSharedSummary(
  conversation?: Conversation | null,
  commonGroupCount = 0,
): ContactProfileSharedSummary {
  let photos = 0;
  let videos = 0;
  let files = 0;
  const links = new Set<string>();
  for (const message of conversation?.messages ?? []) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === 'image') photos += 1;
      else if (attachmentIsVideo(attachment)) videos += 1;
      else files += 1;
    }
    for (const match of message.text.matchAll(/https?:\/\/[^\s<>()]+/giu)) {
      links.add(match[0].replace(/[.,!?;:]+$/u, ''));
    }
  }
  return {
    photos,
    videos,
    files,
    links: links.size,
    commonGroups: Math.max(0, commonGroupCount),
  };
}

export function directCallConversationForMember(
  account: Pick<CloudAccount, 'accountId' | 'displayName' | 'avatar'> | null,
  member: ConversationParticipant,
  contact: Contact | null,
): Conversation | null {
  const localAccountId = account?.accountId.trim() ?? '';
  const remoteAccountId = groupMemberAccountId(member, contact);
  if (
    !localAccountId.startsWith('acct_')
    || !remoteAccountId.startsWith('acct_')
    || localAccountId === remoteAccountId
  ) return null;

  const sessionId = directSessionId(localAccountId, remoteAccountId);
  const localName = account?.displayName?.trim() || 'Me';
  const remoteName = member.name.trim() || contact?.name.trim() || 'Kordi contact';
  return {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: remoteName,
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: 'Cloud',
    directness: 'Direct chat',
    participants: [localName, remoteName],
    canonicalParticipants: [
      {
        id: `human:${localAccountId}`,
        humanId: localAccountId,
        name: localName,
        kind: 'human',
        role: 'self',
        source: 'cloud',
        avatarKey: account?.avatar.seed,
        profileImageUrl: account ? canonicalAvatarImageSource(account.avatar) : null,
      },
      {
        ...member,
        id: member.id.trim() || `human:${remoteAccountId}`,
        humanId: remoteAccountId,
        name: remoteName,
        kind: 'human',
        role: 'person',
        source: 'cloud',
        profileImageUrl: member.profileImageUrl ?? contact?.profileImageUrl ?? null,
      },
    ],
    messages: [],
    identity: {
      sourceHostId: 'cloud',
      localHumanId: localAccountId,
      localHumanName: localName,
      remoteHumanId: remoteAccountId,
      remoteHumanName: remoteName,
    },
  };
}

export type ContactProfileAnchorRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type ContactProfileGeometry = {
  style: CSSProperties;
  placement: 'right' | 'left' | 'floating';
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function contactProfileGeometry(
  anchorRect: ContactProfileAnchorRect,
  viewport = {
    width: typeof window === 'undefined' ? 1280 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight,
  },
): ContactProfileGeometry {
  const margin = 12;
  const gap = 10;
  const width = Math.min(304, Math.max(0, viewport.width - margin * 2));
  const maxHeight = Math.min(640, Math.max(0, viewport.height - margin * 2));
  const right = anchorRect.right + gap;
  const left = anchorRect.left - width - gap;
  const canFitRight = right + width <= viewport.width - margin;
  const canFitLeft = left >= margin;
  const placement = canFitRight ? 'right' : canFitLeft ? 'left' : 'floating';
  const resolvedLeft = placement === 'right'
    ? right
    : placement === 'left'
      ? left
      : (viewport.width - width) / 2;
  const resolvedTop = placement === 'floating'
    ? (viewport.height - maxHeight) / 2
    : anchorRect.top - 48;
  return {
    placement,
    style: {
      left: clamp(resolvedLeft, margin, viewport.width - width - margin),
      top: clamp(resolvedTop, margin, viewport.height - maxHeight - margin),
      width,
      maxHeight,
    },
  };
}

import type { DesktopCollaborationConversation } from '@/kordi-app/types';
import {
  CLOUD_PIXEL_AVATAR_URL_PREFIX,
  cloudAvatarImageUrl,
} from '@/features/cloud/avatar';
import { isCollaborationPersonRuntime } from './runtime';

export function collaborationProfileImageUrl(
  value: string | null | undefined,
): string | null {
  const normalized = cloudAvatarImageUrl(value);
  if (normalized) return normalized;
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith(CLOUD_PIXEL_AVATAR_URL_PREFIX)) return null;
  return trimmed;
}

export function isCollaborationConversationPersonChat(
  conversation: DesktopCollaborationConversation,
) {
  return Boolean(conversation.supportTicketEnabled)
    || isCollaborationPersonRuntime(conversation.peerRuntime)
    || Boolean(
      conversation.peerOwnerName
        && conversation.peerDisplayName
        && conversation.peerOwnerName.trim() === conversation.peerDisplayName.trim(),
    );
}

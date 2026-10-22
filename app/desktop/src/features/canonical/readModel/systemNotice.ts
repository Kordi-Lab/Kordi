import { KORDI_SYSTEM_AVATAR_URL, KORDI_SYSTEM_NAME, KORDI_SYSTEM_NOTICE_KIND } from '@/features/pip/pipIdentity';
import type { CanonicalSessionMessage, Message } from '@/kordi-app/types';

// Takes the kind itself: the read model counts property reads per row.
export function isSystemNoticeKind(messageKind: CanonicalSessionMessage['messageKind'] | null | undefined): boolean {
  return messageKind?.trim() === KORDI_SYSTEM_NOTICE_KIND;
}

/** Sender identity for a server notice; null keeps the poster's own identity. The seed keeps
 * notices from grouping with the posting account's own messages. A notice is never an own
 * bubble, even when the viewer's account posted it (an organizer's plan card). */
export function systemNoticeSender(messageKind: CanonicalSessionMessage['messageKind'] | null | undefined) {
  return isSystemNoticeKind(messageKind)
    ? { sender: KORDI_SYSTEM_NAME, senderProfileImageUrl: KORDI_SYSTEM_AVATAR_URL, showSenderMeta: true, senderAvatarSeed: 'kordi-system', senderOwnerName: undefined, isOwnMessage: false }
    : null;
}

/** Direct-chat rows: re-dresses a mapped message as a System notice, dropping the poster's
 * outbound role, status chips and read receipts. Other kinds pass through unchanged. */
export function withSystemNoticeIdentity(message: Message): Message {
  const notice = systemNoticeSender(message.messageKind);
  return notice
    ? { ...message, ...notice, role: 'person', senderType: 'human', sourceSenderLabel: KORDI_SYSTEM_NAME, statusChips: [], readReceiptSummary: null }
    : message;
}

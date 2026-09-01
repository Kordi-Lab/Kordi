import type { Message } from '../types';
import { liveTurnSnapshotKey } from './transcriptLiveTurns';

export function messageSnapshotKey(msg: Message) {
  return [
    msg.id ?? '',
    msg.entryId ?? '',
    msg.role,
    msg.sender ?? '',
    msg.senderIdentityId ?? '',
    msg.senderType ?? '',
    msg.isOwnMessage ? 'own' : 'peer',
    msg.showSenderMeta ? 'meta' : '',
    msg.text,
    msg.time,
    msg.timestampMs ?? '',
    msg.detail ?? '',
    msg.senderAvatarSeed ?? '',
    msg.senderProfileImageUrl ?? '',
    msg.supportContactResponse ? 'support-contact-response' : '',
    msg.supportContactTyping ? 'support-contact-typing' : '',
    msg.statusChips?.join(',') ?? '',
    msg.replyToMessageId ?? '',
    msg.replyAliasIds?.join('|') ?? '',
    msg.replySummary ? [msg.replySummary.replyCount, msg.replySummary.pending ? 'pending' : 'done', msg.replySummary.targetMessageId ?? ''].join(':') : '',
    msg.threadSummary?.replyCount ?? '',
    msg.readReceiptSummary ? [msg.readReceiptSummary.count, msg.readReceiptSummary.participants.map((participant) => [participant.id, participant.name, participant.readAt ?? ''].join(':')).join('|')].join(':') : '',
    msg.reactionConversationId ?? '',
    msg.reactionTargetMessageId ?? '',
    msg.cloudMessageVersion ?? '',
    msg.editedAt ?? '',
    msg.reactions?.map((reaction) => [reaction.value, reaction.accountIds.join(',')].join(':')).join('|') ?? '',
    msg.sourceMessage ? [msg.sourceMessage.messageId, msg.sourceMessage.text, msg.sourceMessage.senderLabel ?? '', JSON.stringify(msg.sourceMessage.mentions ?? [])].join(':') : '',
    msg.attachments?.map((attachment) => [attachment.kind, attachment.name, attachment.formatLabel ?? '', attachment.previewUrl ?? '', attachment.localPath ?? '', attachment.mimeType ?? ''].join(':')).join('|') ?? '',
    JSON.stringify(msg.mentions ?? []),
    msg.turn ? liveTurnSnapshotKey(msg.turn) : '',
    msg.edit?.files.map((file) => [file.path, file.additions, file.deletions, file.lines.length].join(':')).join('|') ?? '',
  ].join('\u0001');
}

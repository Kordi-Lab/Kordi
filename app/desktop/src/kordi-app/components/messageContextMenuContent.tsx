import { useState, type CSSProperties, type ReactNode } from 'react';
import { CheckCheck, CheckCircle2, Copy, Eye, Forward, MessageCircle, PanelRightOpen, Pencil, Pin, Trash2 } from 'lucide-react';

import {
  attachmentMediaGalleryIndex,
  attachmentPreviewUrl,
} from '@/features/chat/attachmentMediaGallery';
import { openAttachmentMediaWindow } from '@/features/chat/attachmentMediaWindow';
import { cn } from '@/lib/utils';
import type { Message, MessageAttachment, MessageReplyDestination } from '../types';
import { AddAttachmentToMediaLibraryAction } from './addAttachmentToMediaLibraryAction';
import { IdentityAvatar } from './IdentityAvatar';
import { MessageReactionSurface } from './messageReactions';
import { AttachmentActions } from './transcriptAttachmentActions';
import { messageStickerAttachment } from './messageStickerPresentation';
import { transcriptMessageIsOwnHuman } from './transcriptMessageHumanRole';

const textStyle = {
  fontSize: '10px',
  fontWeight: 400,
  lineHeight: 1.45,
} satisfies CSSProperties;

function SeenRow({ summary }: { summary?: Message['readReceiptSummary'] | null }) {
  const count = Math.max(0, Math.floor(summary?.count ?? 0));
  if (count <= 0) return null;
  const participants = (summary?.participants ?? []).slice(0, 4);
  const names = participants.map((participant) => participant.name).filter(Boolean);
  const title = names.length > 0 ? `Seen by ${names.join(', ')}` : `${count} seen`;
  return (
    <div
      className="app-transient-divider app-transient-muted flex items-center gap-2 border-t px-3 py-1.5 text-[10px] font-normal leading-[1.45]"
      data-message-context-menu-seen-row="true"
      title={title}
      style={textStyle}
    >
      <CheckCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{count} Seen</span>
      {participants.length > 0 ? (
        <span className="ml-auto inline-flex -space-x-1" aria-hidden="true">
          {participants.map((participant) => (
            <IdentityAvatar
              key={participant.id}
              kind="human"
              seed={participant.avatarSeed ?? participant.id}
              name={participant.name}
              imageUrl={participant.profileImageUrl}
              className="h-4.5 w-4.5"
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}

function Action({ icon, label, action, onClick, destructive = false }: { icon: ReactNode; label: string; action: string; onClick?: () => void; destructive?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-message-context-menu-action={action}
      className={cn(
        'app-transient-flat-action app-transient-action-row app-message-context-menu-action flex w-full items-center gap-2.5 rounded-[10px] px-3 py-1.5 text-left font-normal transition',
        destructive && 'app-transient-flat-action-danger',
      )}
      style={textStyle}
      onClick={onClick}
    >
      <span className="grid h-4 w-4 shrink-0 place-items-center" aria-hidden="true">{icon}</span>
      <span className="app-transient-action-label">{label}</span>
    </button>
  );
}

export type MessageContextMenuActionHandlers = {
  onReplyMessage?: (message: Message, destination: MessageReplyDestination) => void;
  onOpenMessageThread?: (message: Message) => void;
  onForwardMessage?: (message: Message) => void;
  onEditMessage?: (message: Message) => void;
  onDeleteMessage?: (message: Message) => void;
  onOpenMessageDetail?: (message: Message) => void;
  onSelectMessage?: (message: Message) => void;
  onRequestPinMessage?: (message: Message) => void;
  onRequestUnpinMessage?: (message: Message) => void;
  onReactMessage?: (message: Message, reaction: string) => Promise<void> | void;
  isPinned?: boolean;
};

function isActionEligible(msg: Message) {
  if (!(msg.id ?? msg.entryId ?? msg.turn?.id)) return false;
  if (msg.role === 'system' || msg.role === 'action' || msg.role === 'edit') return false;
  return !msg.turn || msg.turn.completed;
}

function messageCanEdit(msg: Message) {
  const status = new Set((msg.statusChips ?? []).map((value) => value.trim().toLowerCase()));
  return isActionEligible(msg)
    && transcriptMessageIsOwnHuman(msg)
    && msg.senderType === 'human'
    && Boolean(msg.text.trim())
    && Boolean(msg.reactionConversationId && msg.reactionTargetMessageId)
    && Number.isInteger(msg.cloudMessageVersion)
    && Number(msg.cloudMessageVersion) > 0
    && !status.has('sending')
    && !status.has('failed')
    && !['voice', 'sticker', 'call'].includes(msg.messageKind?.trim().toLowerCase() ?? '');
}

function messageCanDelete(msg: Message) {
  return isActionEligible(msg)
    && msg.senderType === 'human'
    && Boolean(msg.reactionConversationId && msg.reactionTargetMessageId);
}

export function MessageContextMenuContent({
  msg,
  onClose,
  onReplyMessage,
  onOpenMessageThread,
  onForwardMessage,
  onEditMessage,
  onDeleteMessage,
  onSelectMessage,
  onRequestPinMessage,
  onRequestUnpinMessage,
  onReactMessage,
  isPinned = false,
  mediaAttachment,
  mediaGallery,
}: {
  msg: Message;
  onClose?: () => void;
  mediaAttachment?: MessageAttachment | null;
  mediaGallery?: readonly MessageAttachment[];
} & MessageContextMenuActionHandlers) {
  const [showsAllReactions, setShowsAllReactions] = useState(false);
  const copyableText = msg.text.trim() || msg.turn?.assistantText?.trim() || msg.detail?.trim() || '';
  const stickerAttachment = messageStickerAttachment(msg);
  const actionEligible = isActionEligible(msg);
  const canEdit = Boolean(onEditMessage && messageCanEdit(msg));
  const canDelete = Boolean(onDeleteMessage && messageCanDelete(msg));
  const canReact = actionEligible
    && Boolean(msg.reactionConversationId && msg.reactionTargetMessageId && onReactMessage);
  const closeAfter = (action?: (message: Message) => void) => {
    action?.(msg);
    onClose?.();
  };
  const closeAfterReply = (destination: MessageReplyDestination) => {
    if (destination === 'thread') onOpenMessageThread?.(msg);
    else onReplyMessage?.(msg, destination);
    onClose?.();
  };
  const copyText = async () => {
    if (!copyableText) return;
    try {
      await navigator.clipboard?.writeText(copyableText);
    } catch {
      // Closing the menu is enough recovery for an unavailable clipboard.
    } finally {
      onClose?.();
    }
  };
  const handleReaction = (reaction: string) => {
    onClose?.();
    void onReactMessage?.(msg, reaction);
  };
  const reviewMediaAttachment = () => {
    if (!mediaAttachment) return;
    const attachments = mediaGallery?.length ? [...mediaGallery] : [mediaAttachment];
    const galleryIndex = attachmentMediaGalleryIndex(attachments, mediaAttachment);
    onClose?.();
    void openAttachmentMediaWindow({
      attachments,
      selectedIndex: galleryIndex >= 0 ? galleryIndex : 0,
      initialPreviewUrl: attachmentPreviewUrl(mediaAttachment),
    }).catch(() => undefined);
  };

  return (
    <div
      className={cn(
        'app-message-context-menu-content max-w-[calc(100vw-1rem)]',
        canReact ? 'w-[17.5rem]' : 'w-[13.5rem]',
      )}
      data-message-context-menu-content="true"
      data-message-context-menu-reactions={canReact || undefined}
    >
      {canReact ? (
        <MessageReactionSurface
          expanded={showsAllReactions}
          onReact={handleReaction}
          onToggleExpanded={() => setShowsAllReactions((current) => !current)}
        />
      ) : null}
      {!showsAllReactions ? <div className="app-transient-surface overflow-hidden rounded-[14px] w-[13.5rem] border p-1">
        {mediaAttachment ? (
          <>
            <Action action="review-attachment" icon={<Eye className="h-4 w-4" />} label="Review" onClick={reviewMediaAttachment} />
            <AttachmentActions attachment={mediaAttachment} variant="menu" />
            <AddAttachmentToMediaLibraryAction attachment={mediaAttachment} onAdded={() => onClose?.()} />
            <div className="app-transient-divider mx-3 my-1 border-t" role="separator" />
          </>
        ) : null}
        {actionEligible && onReplyMessage ? <Action action="reply-conversation" icon={<MessageCircle className="h-4 w-4" />} label="Reply in conversation" onClick={() => closeAfterReply('conversation')} /> : null}
        {actionEligible && onOpenMessageThread ? <Action action="reply-thread" icon={<PanelRightOpen className="h-4 w-4" />} label="Reply in thread" onClick={() => closeAfterReply('thread')} /> : null}
        {canEdit ? <Action action="edit" icon={<Pencil className="h-4 w-4" />} label="Edit" onClick={() => closeAfter(onEditMessage)} /> : null}
        {copyableText ? <Action action="copy-text" icon={<Copy className="h-4 w-4" />} label="Copy" onClick={() => void copyText()} /> : null}
        {actionEligible ? <Action action="forward" icon={<Forward className="h-4 w-4" />} label="Forward" onClick={() => closeAfter(onForwardMessage)} /> : null}
        {stickerAttachment ? <AddAttachmentToMediaLibraryAction attachment={{ ...stickerAttachment, subtype: 'sticker' }} onAdded={() => onClose?.()} /> : null}
        {actionEligible && (onRequestPinMessage || onRequestUnpinMessage) ? (
          isPinned
            ? <Action action="unpin" icon={<Pin className="h-4 w-4" />} label="Unpin" onClick={() => closeAfter(onRequestUnpinMessage)} />
            : <Action action="pin" icon={<Pin className="h-4 w-4" />} label="Pin" onClick={() => closeAfter(onRequestPinMessage)} />
        ) : null}
        {actionEligible ? <div className="app-transient-divider mx-3 my-1 border-t" role="separator" /> : null}
        {actionEligible ? <Action action="select" icon={<CheckCircle2 className="h-4 w-4" />} label="Select" onClick={() => closeAfter(onSelectMessage)} /> : null}
        {canDelete ? <Action action="delete" icon={<Trash2 className="h-4 w-4" />} label="Delete" destructive onClick={() => closeAfter(onDeleteMessage)} /> : null}
        <SeenRow summary={msg.readReceiptSummary} />
      </div> : null}
    </div>
  );
}

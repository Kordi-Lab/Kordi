import { attachmentMediaGalleriesEqual } from '@/features/chat/attachmentMediaGallery';
import {
  relatedAgentSessionsFromTools,
  relatedAgentSessionStatusMapsEqual,
} from '@/features/chat/relatedAgentSessions';
import type { MessageBubbleProps } from './transcript';
import { messageSnapshotKey } from './transcriptMessageSnapshot';

export function messageBubblePinnedIdsEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) {
  if (left === right) return true;
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every((value, index) => value === right?.[index]);
}

function messageUsesRelatedAgentStatuses(message: MessageBubbleProps['msg']) {
  return relatedAgentSessionsFromTools(message.turn?.tools).length > 0;
}

function selectionId(message: MessageBubbleProps['msg']) {
  return message.id ?? message.entryId ?? message.turn?.id ?? '';
}

function isSelected(props: MessageBubbleProps) {
  const id = selectionId(props.msg);
  return Boolean(id && props.selectedMessageIds?.has(id));
}

function isPinned(props: MessageBubbleProps) {
  const id = selectionId(props.msg);
  return Boolean(id && props.pinnedMessageIds?.includes(id));
}

export function messageBubblePropsEqual(
  previous: MessageBubbleProps,
  next: MessageBubbleProps,
) {
  return previous.onOpenSource === next.onOpenSource
    && previous.onOpenMessageThread === next.onOpenMessageThread
    && previous.onStopCollaborationAgentRequest === next.onStopCollaborationAgentRequest
    && previous.onStopActiveTurn === next.onStopActiveTurn
    && previous.onNavigateToMessage === next.onNavigateToMessage
    && previous.onOpenArtifact === next.onOpenArtifact
    && previous.onOpenAuthSettings === next.onOpenAuthSettings
    && previous.onRequestCollaborationContact === next.onRequestCollaborationContact
    && previous.onOpenSenderProfile === next.onOpenSenderProfile
    && previous.onForkMessage === next.onForkMessage
    && previous.onOpenForkSession === next.onOpenForkSession
    && (
      !messageUsesRelatedAgentStatuses(previous.msg)
        && !messageUsesRelatedAgentStatuses(next.msg)
      || relatedAgentSessionStatusMapsEqual(
        previous.relatedAgentSessionStatusById,
        next.relatedAgentSessionStatusById,
      )
    )
    && previous.onReplyMessage === next.onReplyMessage
    && previous.onForwardMessage === next.onForwardMessage
    && previous.onEditMessage === next.onEditMessage
    && previous.onDeleteMessage === next.onDeleteMessage
    && previous.onRetryMessage === next.onRetryMessage
    && previous.onOpenMessageDetail === next.onOpenMessageDetail
    && previous.onSelectMessage === next.onSelectMessage
    && previous.onRequestPinMessage === next.onRequestPinMessage
    && previous.onRequestUnpinMessage === next.onRequestUnpinMessage
    && previous.onReactMessage === next.onReactMessage
    && isPinned(previous) === isPinned(next)
    && previous.selectionMode === next.selectionMode
    && isSelected(previous) === isSelected(next)
    && previous.isMessageSelectable === next.isMessageSelectable
    && previous.onToggleSelectedMessage === next.onToggleSelectedMessage
    && previous.onSelectionDragStart === next.onSelectionDragStart
    && previous.onSelectionDragEnter === next.onSelectionDragEnter
    && previous.onSelectionDragEnd === next.onSelectionDragEnd
    && previous.plainAgentResponse === next.plainAgentResponse
    && previous.messageForks === next.messageForks
    && attachmentMediaGalleriesEqual(previous.imageGallery, next.imageGallery)
    && previous.densityMode === next.densityMode
    && previous.isGroupedWithPrevious === next.isGroupedWithPrevious
    && previous.isGroupedWithNext === next.isGroupedWithNext
    && (previous.msg === next.msg
      || messageSnapshotKey(previous.msg) === messageSnapshotKey(next.msg));
}

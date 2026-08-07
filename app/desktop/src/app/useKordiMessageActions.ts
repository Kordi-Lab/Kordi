import { createElement, useCallback, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { MessageForwardDialog } from '@/pages/MessageForwardDialog';
import { cloudGroupMessageSessionId, cloudGroupTargetAccountIds } from '@/features/cloud/cloudGroupMessages';
import { isCloudCollaborationConversationId } from '@/features/cloud/cloudCollaborationState';
import { encodeCloudDirectMessageEnvelope } from '@/features/cloud/cloudDirectMessages';
import type { CloudAccount } from '@/features/cloud/authClient';
import type { UseCloudCollaborationStateResult } from '@/features/cloud/useCloudCollaborationState';
import {
  collaborationGroupSessionParticipants,
  collaborationGroupSessionSendTargets,
  collaborationGroupSessionSpaceId,
  isCollaborationGroupSession,
} from '@/features/chat/messageActions/chatMessages';
import {
  forwardMessageSourceFromMessage,
  messageActionSourceFromMessage,
  type ForwardMessageSource,
} from '@/features/chat/messageActionMetadata';
import {
  formatSelectedMessagesForCopy,
} from '@/features/chat/messageSelection';
import {
  buildForwardDestinations,
  createForwardedMessageDrafts,
  orderedForwardSourcesForMessageIds,
  revealForwardedMessageInDestination,
  type ForwardDestination,
} from '@/features/chat/messageForwarding';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import { CHAT_COMPOSER_TEXTAREA_SELECTOR, focusComposerTextareaForNativeInput } from '@/features/chat/composerController.shared';
import { navigateToTranscriptMessageOrScrollBottom, scrollTranscriptToBottom } from '@/features/chat/transcriptNavigation';
import type {
  CanonicalSessionState,
  ComposerQuoteState,
  Conversation,
  DesktopCollaborationState,
  Message,
} from '@/kordi-app/types';
import { appendCanonicalMessage } from '@/lib/desktop';
import { useMessageSelectionActions } from './useMessageSelectionActions';

type MessageActionCloudTransport = Pick<
  UseCloudCollaborationStateResult,
  | 'prepareCloudForwardAttachments'
  | 'sendCloudCollaborationMessage'
  | 'sendCloudGroupControl'
>;

type UseKordiMessageActionsArgs = {
  activeConversation: Conversation;
  conversations: Conversation[];
  draftSessionId: string;
  isNativeShell: boolean;
  transcriptScrollRef: MutableRefObject<HTMLDivElement | null>;
  setActiveConversationId: (conversationId: string) => void;
  setDesktopChatError: (message: string | null) => void;
  setChatQuoteBySessionId: Dispatch<
    SetStateAction<Record<string, ComposerQuoteState | null>>
  >;
  canonicalState: CanonicalSessionState | null;
  setCanonicalState: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  account: CloudAccount | null;
  collaborationState: DesktopCollaborationState | null;
  cloudTransport: MessageActionCloudTransport;
};

type ForwardDialogState = {
  sources: ForwardMessageSource[];
  destinations: ForwardDestination[];
};

export function useKordiMessageActions({
  activeConversation,
  conversations,
  draftSessionId,
  isNativeShell,
  transcriptScrollRef,
  setActiveConversationId,
  setDesktopChatError,
  setChatQuoteBySessionId,
  canonicalState,
  setCanonicalState,
  account,
  collaborationState,
  cloudTransport,
}: UseKordiMessageActionsArgs) {
  const [forwardDialog, setForwardDialog] =
    useState<ForwardDialogState | null>(null);
  const {
    prepareCloudForwardAttachments,
    sendCloudCollaborationMessage,
    sendCloudGroupControl,
  } = cloudTransport;
  const copyTextToClipboard = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch (error) {
      setDesktopChatError(
        error instanceof Error ? error.message : 'Unable to copy details',
      );
    }
  }, [setDesktopChatError]);

  const onReplyMessage = useCallback((message: Message) => {
    const source = messageActionSourceFromMessage(
      message,
      activeConversation.canonicalSessionId
        ?? activeConversation.id
        ?? draftSessionId,
    );
    if (!source) return;
    setChatQuoteBySessionId((current) => ({
      ...current,
      [draftSessionId]: { action: 'quote', source },
    }));
    focusComposerTextareaForNativeInput(
      CHAT_COMPOSER_TEXTAREA_SELECTOR,
      isNativeShell,
    );
  }, [
    activeConversation.canonicalSessionId,
    activeConversation.id,
    draftSessionId,
    isNativeShell,
    setChatQuoteBySessionId,
  ]);

  const sourceForSelectableMessage = useCallback((message: Message) => (
    forwardMessageSourceFromMessage(
      message,
      activeConversation.canonicalSessionId
        ?? activeConversation.id
        ?? draftSessionId,
    )
  ), [
    activeConversation.canonicalSessionId,
    activeConversation.id,
    draftSessionId,
  ]);

  const onForwardMessage = useCallback((message: Message) => {
    const source = sourceForSelectableMessage(message);
    if (!source) return;
    const destinations = buildForwardDestinations(
      conversations,
      LOCAL_DRAFT_CHAT_CONVERSATION_ID,
    );
    if (!destinations.length) return;
    setForwardDialog({ sources: [source], destinations });
  }, [conversations, sourceForSelectableMessage]);

  const {
    activeMessageSelection,
    selectedMessageIds,
    selectedMessageCount,
    isMessageSelectable,
    onSelectMessage,
    onToggleSelectedMessage,
    onCancelMessageSelection,
    onSelectAllMessages,
    onSelectionDragStart,
    onSelectionDragEnter,
    onSelectionDragEnd,
  } = useMessageSelectionActions({ activeConversation, sourceForSelectableMessage });

  const orderedSelectedMessageSources = useCallback(() => {
    if (
      !activeMessageSelection
      || activeMessageSelection.sourcesByMessageId.size === 0
    ) {
      return [];
    }
    const orderedMessageIds = activeConversation.messages
      .map((message) => (
        message.id?.trim()
        || message.entryId?.trim()
        || ''
      ))
      .filter(Boolean);
    return orderedForwardSourcesForMessageIds(
      orderedMessageIds,
      activeMessageSelection.sourcesByMessageId,
    );
  }, [activeConversation.messages, activeMessageSelection]);

  const onCopySelectedMessages = useCallback(() => {
    const sources = orderedSelectedMessageSources();
    if (sources.length === 0) return;
    void copyTextToClipboard(formatSelectedMessagesForCopy(sources));
  }, [copyTextToClipboard, orderedSelectedMessageSources]);

  const onForwardSelectedMessages = useCallback(() => {
    const sources = orderedSelectedMessageSources();
    if (sources.length === 0) return;
    const destinations = buildForwardDestinations(
      conversations,
      LOCAL_DRAFT_CHAT_CONVERSATION_ID,
    );
    if (!destinations.length) return;
    setForwardDialog({ sources, destinations });
  }, [conversations, orderedSelectedMessageSources]);

  const revealForward = useCallback((
    destinationConversationId: string,
    forwardedMessageId?: string | null,
  ) => {
    revealForwardedMessageInDestination({
      destinationConversationId,
      forwardedMessageId,
      setActiveConversationId,
      revealMessage: (messageId) => (
        navigateToTranscriptMessageOrScrollBottom(
          messageId,
          transcriptScrollRef,
        )
      ),
      revealLatest: () => scrollTranscriptToBottom(transcriptScrollRef),
    });
  }, [setActiveConversationId, transcriptScrollRef]);

  const confirmForwardMessage = useCallback((
    destination: ForwardDestination,
    caption: string,
  ) => {
    const senderIdentityId =
      canonicalState?.profile.humanIdentityId?.trim();
    const sources = forwardDialog?.sources ?? [];
    if (!senderIdentityId || sources.length === 0) return;
    const destinationConversation = conversations.find((conversation) => (
      conversation.id === destination.conversationId
      || conversation.id === destination.id
      || conversation.canonicalSessionId === destination.id
    )) ?? null;
    if (!destinationConversation) {
      setDesktopChatError('Forward destination is no longer available.');
      return;
    }
    const drafts = createForwardedMessageDrafts({ sources, caption });
    const now = Date.now();
    setForwardDialog(null);
    onCancelMessageSelection();
    const directCloudConversationId =
      isCloudCollaborationConversationId(destination.conversationId)
        ? destination.conversationId
        : null;
    if (directCloudConversationId) {
      setActiveConversationId(directCloudConversationId);
      void (async () => {
        for (const draft of drafts) {
          const attachments = await prepareCloudForwardAttachments(
            draft.attachments,
          );
          const body = encodeCloudDirectMessageEnvelope({
            schemaVersion: 1,
            kind: 'message',
            text: draft.text,
            messageAction: draft.messageAction,
          });
          await sendCloudCollaborationMessage(
            directCloudConversationId,
            body,
            attachments,
          );
        }
        revealForward(directCloudConversationId);
      })().catch((error: unknown) => {
        setDesktopChatError(
          error instanceof Error
            ? error.message
            : 'Unable to forward messages',
        );
      });
      return;
    }
    void (async () => {
      let lastForwardMessageId: string | null = null;
      for (const [index, draft] of drafts.entries()) {
        const source = sources[index];
        if (!source) continue;
        const forwardMessageId =
          `msg:forward:${destination.id}:${source.sourceMessageId}:${now}:${index}`;
        lastForwardMessageId = forwardMessageId;
        const nextState = await appendCanonicalMessage({
          id: forwardMessageId,
          sessionId: destination.id,
          senderIdentityId,
          senderRole: 'user',
          messageKind: 'text',
          contentText: draft.text,
          content: {
            ...(draft.attachments.length > 0
              ? { attachments: draft.attachments }
              : {}),
            forwardedFrom: draft.forwardedFrom,
            messageAction: draft.messageAction,
          },
          createdAtMs: now + index,
          parentMessageId: null,
          status: 'sent',
          sourceTransport: 'desktop-forward',
          sourceEventId:
            `desktop-forward:${destination.id}:${source.sourceMessageId}:${now}:${index}`,
        });
        setCanonicalState(nextState);
        if (!account) continue;
        const groupScope = {
          canonicalSessionId: destination.id,
          participantSpaceId: destinationConversation.participantSpaceId,
          directness: destinationConversation.directness,
          canonicalParticipants:
            destinationConversation.canonicalParticipants,
        };
        if (!isCollaborationGroupSession(groupScope)) continue;
        const activeCollaborationHost =
          collaborationState?.hosts.find((host) => (
            host.id === collaborationState.activeHostId
          ))
          ?? collaborationState?.hosts[0]
          ?? null;
        const selfPublicCollaborationName =
          activeCollaborationHost?.ownerName?.trim()
          || activeCollaborationHost?.displayName?.trim()
          || null;
        const selfCollaborationNodeIds = new Set(
          (collaborationState?.hosts ?? [])
            .map((host) => host.nodeId?.trim())
            .filter((value): value is string => Boolean(value)),
        );
        const targets = collaborationGroupSessionSendTargets(
          groupScope,
          null,
          selfCollaborationNodeIds,
        );
        const targetAccountIds = cloudGroupTargetAccountIds(targets);
        if (targetAccountIds.length === 0) continue;
        const groupSpaceId =
          collaborationGroupSessionSpaceId(groupScope);
        const attachments = await prepareCloudForwardAttachments(
          draft.attachments,
        );
        await sendCloudGroupControl({
          targetAccountIds,
          kind: 'group-message',
          groupId: cloudGroupMessageSessionId({
            activeConvCanonicalSessionId: destination.id,
            activeGroupSessionSpaceId: groupSpaceId,
          }),
          groupSpaceId,
          groupTitle: null,
          collaborationParticipants:
            collaborationGroupSessionParticipants(groupScope, {
              selfPublicName: selfPublicCollaborationName,
            }),
          message: {
            id: forwardMessageId,
            senderAccountId: '',
            text: draft.text,
            createdAtMs: now + index,
            messageAction: draft.messageAction,
          },
          attachments,
        });
      }
      revealForward(destination.conversationId, lastForwardMessageId);
    })().catch((error: unknown) => {
      setDesktopChatError(
        error instanceof Error
          ? error.message
          : 'Unable to forward messages',
      );
    });
  }, [
    account,
    canonicalState?.profile.humanIdentityId,
    collaborationState,
    conversations,
    forwardDialog?.sources,
    onCancelMessageSelection,
    prepareCloudForwardAttachments,
    revealForward,
    sendCloudCollaborationMessage,
    sendCloudGroupControl,
    setActiveConversationId,
    setCanonicalState,
    setDesktopChatError,
  ]);

  const messageForwardDialog = forwardDialog
    ? createElement(MessageForwardDialog, {
        sources: forwardDialog.sources,
        destinations: forwardDialog.destinations,
        onClose: () => setForwardDialog(null),
        onForward: confirmForwardMessage,
      })
    : null;

  return {
    activeMessageSelection,
    selectedMessageIds,
    selectedMessageCount,
    onReplyMessage,
    onForwardMessage,
    onSelectMessage,
    isMessageSelectable,
    onToggleSelectedMessage,
    onSelectionDragStart,
    onSelectionDragEnter,
    onSelectionDragEnd,
    onCancelMessageSelection,
    onSelectAllMessages,
    onCopySelectedMessages,
    onForwardSelectedMessages,
    messageForwardDialog,
  };
}

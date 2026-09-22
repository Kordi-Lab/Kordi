import { createElement, useCallback, useState } from 'react';

import { MessageForwardDialog } from '@/pages/MessageForwardDialog';
import { cloudGroupMessageSessionId, cloudGroupTargetAccountIds } from '@/features/cloud/cloudGroupMessages';
import { isCloudCollaborationConversationId } from '@/features/cloud/cloudCollaborationState';
import { encodeCloudDirectMessageEnvelope } from '@/features/cloud/cloudDirectMessages';
import {
  collaborationGroupSessionParticipants,
  collaborationGroupSessionSendTargets,
  collaborationGroupSessionSpaceId,
  isCollaborationGroupSession,
} from '@/features/chat/messageActions/chatMessages';
import {
  forwardMessageSourceFromMessage,
  messageActionSourceFromMessage,
} from '@/features/chat/messageActionMetadata';
import { threadRootSource } from '@/features/chat/messageThreads';
import {
  formatSelectedMessagesForCopy,
} from '@/features/chat/messageSelection';
import {
  buildForwardDestinations,
  forwardContactConversationId,
  forwardDestinationPath,
  createForwardedMessageDrafts,
  orderedForwardSourcesForMessageIds,
  revealForwardedMessageInDestination,
  type ForwardDestination,
} from '@/features/chat/messageForwarding';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import { CHAT_COMPOSER_TEXTAREA_SELECTOR, focusComposerTextareaForNativeInput } from '@/features/chat/composerController.shared';
import { navigateToTranscriptMessageOrScrollBottom, scrollTranscriptToBottom } from '@/features/chat/transcriptNavigation';
import type {
  Contact,
  Message,
} from '@/kordi-app/types';
import { appendCanonicalMessageFast } from '@/lib/desktop';
import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import { useMessageSelectionActions } from './useMessageSelectionActions';
import { useKordiMessageMutations } from './useKordiMessageMutations';

import type { ForwardBatchProgress, ForwardDialogState, UseKordiMessageActionsArgs } from './useKordiMessageActions.types';

const EMPTY_CONTACTS: Contact[] = [];

export function useKordiMessageActions({
  activeConversation,
  conversations,
  contacts = EMPTY_CONTACTS,
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
  const [forwardProgress] = useState(() => new WeakMap<ForwardDialogState, ForwardBatchProgress>());
  const {
    prepareCloudForwardAttachments,
    sendCloudCollaborationMessage,
    sendCloudGroupControl,
    setCloudMessageReaction,
    editCloudMessage,
    deleteCloudMessage,
  } = cloudTransport;
  const messageMutations = useKordiMessageMutations({
    activeConversation,
    canonicalState,
    draftSessionId,
    isNativeShell,
    setDesktopChatError,
    setChatQuoteBySessionId,
    setCanonicalState,
    editCloudMessage,
    deleteCloudMessage,
  });
  const copyTextToClipboard = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch (error) {
      setDesktopChatError(
        error instanceof Error ? error.message : 'Unable to copy details',
      );
    }
  }, [setDesktopChatError]);

  const onReplyMessage = useCallback((message: Message, destination: 'conversation' | 'thread') => {
    const sessionId = activeConversation.canonicalSessionId
      ?? activeConversation.id
      ?? draftSessionId;
    const source = destination === 'thread'
      ? threadRootSource(message, sessionId)
      : messageActionSourceFromMessage(message, sessionId);
    if (!source) return;
    setChatQuoteBySessionId((current) => ({
      ...current,
      [draftSessionId]: { action: destination === 'thread' ? 'thread' : 'quote', source },
    }));
    if (destination === 'conversation') {
      focusComposerTextareaForNativeInput(
        CHAT_COMPOSER_TEXTAREA_SELECTOR,
        isNativeShell,
      );
    }
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
      contacts,
    );
    const origin = destinations.find((destination) => destination.conversationId === activeConversation.id);
    setForwardDialog({ sources: [source], destinations, sourceLabel: origin ? forwardDestinationPath(origin) : activeConversation.name });
  }, [activeConversation.id, activeConversation.name, contacts, conversations, sourceForSelectableMessage]);

  const onReactMessage = useCallback(async (message: Message, reaction: string) => {
    const conversationId = message.reactionConversationId?.trim();
    const messageId = message.reactionTargetMessageId?.trim();
    const accountId = account?.accountId?.trim();
    if (!conversationId || !messageId || !accountId) return;
    const active = message.reactions
      ?.find((item) => item.value === reaction)
      ?.accountIds.includes(accountId) === true;
    setDesktopChatError(null);
    try {
      await setCloudMessageReaction({
        conversationId,
        messageId,
        reaction,
        active: !active,
      });
    } catch (error) {
      setDesktopChatError(
        error instanceof Error ? error.message : 'Unable to update reaction',
      );
    }
  }, [account?.accountId, setCloudMessageReaction, setDesktopChatError]);

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
      contacts,
    );
    const origin = destinations.find((destination) => destination.conversationId === activeConversation.id);
    setForwardDialog({ sources, destinations, sourceLabel: origin ? forwardDestinationPath(origin) : activeConversation.name });
  }, [activeConversation.id, activeConversation.name, contacts, conversations, orderedSelectedMessageSources]);

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

  const confirmForwardMessage = useCallback(async (
    destination: ForwardDestination,
    caption: string,
    onProgress?: (completed: number) => void,
  ) => {
    const senderIdentityId =
      canonicalState?.profile.humanIdentityId?.trim();
    const sources = forwardDialog?.sources ?? [];
    if (!forwardDialog || sources.length === 0) throw new Error('The selected messages are no longer available.');
    const destinationConversation = conversations.find((conversation) => (
      conversation.id === destination.conversationId
      || conversation.id === destination.id
      || conversation.canonicalSessionId === destination.id
    )) ?? null;
    const contactAvailable = contacts.some((contact) => contact.id === destination.contactId && forwardContactConversationId(contact) === destination.conversationId);
    if (!destinationConversation && !contactAvailable) {
      throw new Error('This destination is no longer available. Close this dialog and choose another chat.');
    }
    const drafts = createForwardedMessageDrafts({ sources, caption });
    let progress = forwardProgress.get(forwardDialog);
    if (!progress) {
      progress = { destinationId: destination.id, requestIds: sources.map(() => crypto.randomUUID()), now: Date.now(), nextIndex: 0, appended: new Set(), lastMessageId: null };
      forwardProgress.set(forwardDialog, progress);
    }
    if (progress.destinationId !== destination.id) throw new Error('Retry with the original destination.');
    const completeMessage = (index: number) => {
      progress.nextIndex = index + 1;
      onProgress?.(progress.nextIndex);
    };
    onProgress?.(progress.nextIndex);
    const now = progress.now;
    const directCloudConversationId =
      isCloudCollaborationConversationId(destination.conversationId)
        ? destination.conversationId
        : null;
    if (directCloudConversationId) {
      try {
        for (const [index, draft] of drafts.entries()) {
          if (index < progress.nextIndex) continue;
          const voiceAttachment = draft.voiceMessage ? [{
            kind: 'file' as const,
            name: 'Voice message.m4a',
            mimeType: draft.voiceMessage.mimeType,
            localPath: draft.voiceMessage.localPath ?? null,
            attachmentId: draft.voiceMessage.mediaId,
          }] : [];
          const attachments = draft.voiceMessage
            ? await prepareCloudForwardAttachments(voiceAttachment)
            : await prepareCloudForwardAttachments(draft.attachments);
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
            {
              clientMessageId: progress.requestIds[index],
              ...(draft.voiceMessage ? {
                messageKind: 'voice',
                voiceMessage: {
                  mimeType: draft.voiceMessage.mimeType,
                  durationMs: draft.voiceMessage.durationMs,
                  waveformSamples: draft.voiceMessage.waveformSamples,
                  transcript: draft.voiceMessage.transcript,
                },
              } : {}),
            },
          );
          completeMessage(index);
        }
        onCancelMessageSelection();
        revealForward(directCloudConversationId);
      } catch {
        throw new Error('Couldn’t finish forwarding. Try again to continue with the remaining messages.');
      }
      return;
    }
    if (!senderIdentityId || !destinationConversation) throw new Error('Your account is not ready to forward. Close this dialog and try again.');
    try {
      let lastForwardMessageId: string | null = progress.lastMessageId;
      for (const [index, draft] of drafts.entries()) {
        if (index < progress.nextIndex) continue;
        const source = sources[index];
        if (!source) continue;
        const forwardMessageId =
          `msg:forward:${destination.id}:${source.sourceMessageId}:${now}:${index}`;
        lastForwardMessageId = forwardMessageId;
        progress.lastMessageId = forwardMessageId;
        if (!progress.appended.has(forwardMessageId)) {
          const row = await appendCanonicalMessageFast({
            id: forwardMessageId,
            sessionId: destination.id,
            senderIdentityId,
            senderRole: 'user',
            messageKind: draft.voiceMessage ? 'voice' : 'text',
            contentText: draft.text,
            content: {
              ...(draft.attachments.length > 0
                ? { attachments: draft.attachments }
                : {}),
              ...(draft.voiceMessage ? { voiceMessage: draft.voiceMessage } : {}),
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
          setCanonicalState((current) => mergeCanonicalMessageRow(current, row));
          progress.appended.add(forwardMessageId);
        }
        if (!account) { completeMessage(index); continue; }
        const groupScope = {
          canonicalSessionId: destination.id,
          participantSpaceId: destinationConversation.participantSpaceId,
          directness: destinationConversation.directness,
          canonicalParticipants:
            destinationConversation.canonicalParticipants,
        };
        if (!isCollaborationGroupSession(groupScope)) { completeMessage(index); continue; }
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
        if (targetAccountIds.length === 0) { completeMessage(index); continue; }
        const groupSpaceId =
          collaborationGroupSessionSpaceId(groupScope);
        const attachments = await prepareCloudForwardAttachments(
          draft.voiceMessage ? [{
            kind: 'file',
            name: 'Voice message.m4a',
            mimeType: draft.voiceMessage.mimeType,
            localPath: draft.voiceMessage.localPath ?? null,
            attachmentId: draft.voiceMessage.mediaId,
          }] : draft.attachments,
        );
        await sendCloudGroupControl({
          targetAccountIds,
          kind: 'group-message',
          completion: 'acknowledged',
          retryFailed: true,
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
            messageKind: draft.voiceMessage ? 'voice' : 'text',
            voiceMessage: draft.voiceMessage ? {
              mimeType: draft.voiceMessage.mimeType,
              durationMs: draft.voiceMessage.durationMs,
              waveformSamples: draft.voiceMessage.waveformSamples,
              transcript: draft.voiceMessage.transcript,
            } : null,
          },
          attachments,
        });
        completeMessage(index);
      }
      onCancelMessageSelection();
      revealForward(destination.conversationId, lastForwardMessageId);
    } catch {
      throw new Error('Couldn’t finish forwarding. Try again to continue with the remaining messages.');
    }
  }, [
    account,
    canonicalState?.profile.humanIdentityId,
    collaborationState,
    conversations,
    contacts,
    forwardDialog,
    forwardProgress,
    onCancelMessageSelection,
    prepareCloudForwardAttachments,
    revealForward,
    sendCloudCollaborationMessage,
    sendCloudGroupControl,
    setCanonicalState,
  ]);

  const messageForwardDialog = forwardDialog
    ? createElement(MessageForwardDialog, {
        sources: forwardDialog.sources,
        destinations: forwardDialog.destinations,
        sourceLabel: forwardDialog.sourceLabel,
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
    onReactMessage,
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
    ...messageMutations,
  };
}

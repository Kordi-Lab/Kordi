import { createElement, useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { flushSync } from 'react-dom';

import { CHAT_COMPOSER_TEXTAREA_SELECTOR, focusComposerTextareaForNativeInput } from '@/features/chat/composerController.shared';
import { prepareMessageDeleteAnimation } from '@/features/chat/messageDeleteAnimation';
import type { UseCloudCollaborationStateResult } from '@/features/cloud/useCloudCollaborationState';
import { deleteCanonicalCloudMessage } from '@/features/canonical/canonicalMessageSources';
import type { CanonicalSessionState, ComposerQuoteState, Conversation, Message, MessageEditState } from '@/kordi-app/types';
import { MessageDeleteDialog } from '@/pages/MessageDeleteDialog';

type MessageMutationTransport = Pick<
  UseCloudCollaborationStateResult,
  'editCloudMessage' | 'deleteCloudMessage'
>;

export function useKordiMessageMutations({
  activeConversation,
  canonicalState,
  draftSessionId,
  isNativeShell,
  setDesktopChatError,
  setChatQuoteBySessionId,
  setCanonicalState,
  editCloudMessage,
  deleteCloudMessage,
}: {
  activeConversation: Conversation;
  canonicalState: CanonicalSessionState | null;
  draftSessionId: string;
  isNativeShell: boolean;
  setDesktopChatError: (message: string | null) => void;
  setChatQuoteBySessionId: Dispatch<SetStateAction<Record<string, ComposerQuoteState | null>>>;
  setCanonicalState: Dispatch<SetStateAction<CanonicalSessionState | null>>;
} & MessageMutationTransport) {
  const [messageEdit, setMessageEdit] = useState<MessageEditState | null>(null);
  const [messageEditBusy, setMessageEditBusy] = useState(false);
  const messageEditBusyRef = useRef(false);
  const [messageEditError, setMessageEditError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Message | null>(null);

  const onEditMessage = useCallback((message: Message) => {
    const conversationId = message.reactionConversationId?.trim();
    const messageId = message.reactionTargetMessageId?.trim();
    const expectedVersion = Number(message.cloudMessageVersion);
    if (!conversationId || !messageId || !Number.isInteger(expectedVersion) || expectedVersion < 1) return;
    setChatQuoteBySessionId((current) => ({ ...current, [draftSessionId]: null }));
    setMessageEdit({
      sessionId: draftSessionId,
      conversationId,
      messageId,
      expectedVersion,
      originalText: message.text,
      text: message.text,
    });
    setMessageEditError(null);
    focusComposerTextareaForNativeInput(CHAT_COMPOSER_TEXTAREA_SELECTOR, isNativeShell);
  }, [draftSessionId, isNativeShell, setChatQuoteBySessionId]);

  const updateMessageEditText = useCallback((text: string) => {
    setMessageEdit((current) => current ? { ...current, text } : current);
    setMessageEditError(null);
  }, []);

  const cancelMessageEdit = useCallback(() => {
    if (messageEditBusy) return;
    setMessageEdit(null);
    setMessageEditError(null);
  }, [messageEditBusy]);

  const saveMessageEdit = useCallback(async () => {
    if (
      !messageEdit
      || messageEditBusyRef.current
      || !messageEdit.text.trim()
      || messageEdit.text === messageEdit.originalText
    ) return;
    messageEditBusyRef.current = true;
    setMessageEditBusy(true);
    setMessageEditError(null);
    const pendingEdit = messageEdit;
    setMessageEdit(null);
    try {
      await editCloudMessage({
        conversationId: pendingEdit.conversationId,
        messageId: pendingEdit.messageId,
        expectedVersion: pendingEdit.expectedVersion,
        text: pendingEdit.text,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not edit message.';
      setMessageEdit((current) => current ?? pendingEdit);
      setMessageEditError(message);
      setDesktopChatError(message);
    } finally {
      messageEditBusyRef.current = false;
      setMessageEditBusy(false);
    }
  }, [editCloudMessage, messageEdit, setDesktopChatError]);

  const onDeleteMessage = useCallback((message: Message) => {
    if (!message.reactionConversationId?.trim() || !message.reactionTargetMessageId?.trim()) return;
    setDesktopChatError(null);
    setDeleteTarget(message);
  }, [setDesktopChatError]);

  const messageDeleteDialog = deleteTarget
    ? createElement(MessageDeleteDialog, {
        message: deleteTarget,
        peerName: activeConversation.name,
        group: (activeConversation.canonicalSessionId ?? activeConversation.id).startsWith('session:group:'),
        onCancel: () => setDeleteTarget(null),
        onDelete: async (forEveryone: boolean) => {
          const conversationId = deleteTarget.reactionConversationId?.trim();
          const messageId = deleteTarget.reactionTargetMessageId?.trim();
          if (!conversationId || !messageId) throw new Error('Message is no longer available.');
          const localMessageIds = new Set([
            deleteTarget.id?.trim(),
            deleteTarget.entryId?.trim(),
            messageId,
          ].filter((value): value is string => Boolean(value)));
          const deletionAnimation = await prepareMessageDeleteAnimation(localMessageIds).catch(() => null);
          const removedCanonicalMessages = canonicalState?.messages.filter((message) => (
            localMessageIds.has(message.id)
            || localMessageIds.has(message.sourceEventId?.trim() ?? '')
          )) ?? [];
          const deletion = deleteCloudMessage({ conversationId, messageId, forEveryone });
          flushSync(() => {
            setCanonicalState((current) => {
              if (!current) return current;
              const messages = current.messages.filter((message) => (
                !localMessageIds.has(message.id)
                && !localMessageIds.has(message.sourceEventId?.trim() ?? '')
              ));
              return messages.length === current.messages.length
                ? current
                : { ...current, messages };
            });
            setDeleteTarget(null);
            if (messageEdit?.messageId === messageId) setMessageEdit(null);
          });
          const animation = deletionAnimation?.play();
          try {
            await deletion;
            const deletedCanonicalIds = new Set(await deleteCanonicalCloudMessage(messageId));
            if (deletedCanonicalIds.size > 0) {
              setCanonicalState((current) => current && ({
                ...current,
                messages: current.messages.filter((message) => !deletedCanonicalIds.has(message.id)),
              }));
            }
          } catch (error) {
            deletionAnimation?.cancel();
            setCanonicalState((current) => {
              if (!current || removedCanonicalMessages.length === 0) return current;
              const currentIds = new Set(current.messages.map((message) => message.id));
              const missing = removedCanonicalMessages.filter((message) => !currentIds.has(message.id));
              return missing.length === 0
                ? current
                : {
                    ...current,
                    messages: [...current.messages, ...missing].sort((left, right) => (
                      left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id)
                    )),
                  };
            });
            setDesktopChatError(error instanceof Error ? error.message : 'Could not delete message.');
            return;
          }
          await animation;
        },
      })
    : null;

  return {
    activeMessageEdit: messageEdit?.sessionId === draftSessionId ? messageEdit : null,
    messageEditBusy,
    messageEditError,
    updateMessageEditText,
    cancelMessageEdit,
    saveMessageEdit,
    onEditMessage,
    onDeleteMessage,
    messageDeleteDialog,
  };
}

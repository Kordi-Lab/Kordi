import { createElement, useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { CHAT_COMPOSER_TEXTAREA_SELECTOR, focusComposerTextareaForNativeInput } from '@/features/chat/composerController.shared';
import type { UseCloudCollaborationStateResult } from '@/features/cloud/useCloudCollaborationState';
import type { CanonicalSessionState, ComposerQuoteState, Conversation, Message, MessageEditState } from '@/kordi-app/types';
import { MessageDeleteDialog } from '@/pages/MessageDeleteDialog';

type MessageMutationTransport = Pick<
  UseCloudCollaborationStateResult,
  'editCloudMessage' | 'deleteCloudMessage'
>;

export function useKordiMessageMutations({
  activeConversation,
  draftSessionId,
  isNativeShell,
  setDesktopChatError,
  setChatQuoteBySessionId,
  setCanonicalState,
  editCloudMessage,
  deleteCloudMessage,
}: {
  activeConversation: Conversation;
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
    try {
      await editCloudMessage({
        conversationId: messageEdit.conversationId,
        messageId: messageEdit.messageId,
        expectedVersion: messageEdit.expectedVersion,
        text: messageEdit.text,
      });
      setMessageEdit(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not edit message.';
      setMessageEditError(message);
      setDesktopChatError(message);
    } finally {
      messageEditBusyRef.current = false;
      setMessageEditBusy(false);
    }
  }, [editCloudMessage, messageEdit, setDesktopChatError]);

  const onDeleteMessage = useCallback((message: Message) => {
    if (!message.reactionConversationId?.trim() || !message.reactionTargetMessageId?.trim()) return;
    setDeleteTarget(message);
  }, []);

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
          await deleteCloudMessage({ conversationId, messageId, forEveryone });
          const localMessageIds = new Set([
            deleteTarget.id?.trim(),
            deleteTarget.entryId?.trim(),
            messageId,
          ].filter((value): value is string => Boolean(value)));
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
          if (messageEdit?.messageId === messageId) setMessageEdit(null);
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

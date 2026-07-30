import { useCallback, useMemo, useState } from 'react';

import type { CloudSessionPin } from '@/features/cloud/authClient';
import {
  isCloudCollaborationConversationId,
  isCloudCollaborationHostId,
} from '@/features/cloud/cloudCollaborationState';
import type { Conversation, Message } from '@/kordi-app/types';
import {
  chatMessageActionId,
  pinnedMessageCandidateIds,
  stableCloudPinMessageId,
} from '@/pages/chatsPage.pinModel';

type PinDialog = {
  mode: 'pin' | 'unpin';
  message: Message;
};

type UseChatPinsInput = {
  conversation: Conversation;
  messages: readonly Message[];
  sessionId: string;
  isGroupSession: boolean;
  cloudPin?: CloudSessionPin | null;
  onUpdateCloudPin?: (input: {
    sessionId: string;
    messageId: string | null;
    scope: 'private' | 'shared';
  }) => Promise<CloudSessionPin>;
  onNavigateToMessage: (messageId: string) => void;
};

export function useChatPins({
  conversation,
  messages,
  sessionId,
  isGroupSession,
  cloudPin,
  onUpdateCloudPin,
  onNavigateToMessage,
}: UseChatPinsInput) {
  const [localPinIds, setLocalPinIds] = useState<Record<string, string | null>>({});
  const [optimisticCloudPins, setOptimisticCloudPins] = useState<Record<string, CloudSessionPin>>({});
  const [dialog, setDialog] = useState<PinDialog | null>(null);
  const [pinForEveryone, setPinForEveryone] = useState(false);
  const usesCloudPins = Boolean(
    sessionId
      && onUpdateCloudPin
      && (
        conversation.collaborationSources.some((sourceId) => (
          isCloudCollaborationHostId(sourceId)
        ))
        || isCloudCollaborationHostId(conversation.collaborationTarget?.hostId)
        || isCloudCollaborationHostId(conversation.identity?.sourceHostId)
        || isCloudCollaborationConversationId(conversation.id)
        || isGroupSession
      ),
  );

  const optimisticCloudPin = optimisticCloudPins[sessionId] ?? null;
  const activeCloudPin = usesCloudPins
    ? optimisticCloudPin
      && (!cloudPin
        || (optimisticCloudPin.updatedAt ?? '') >= (cloudPin.updatedAt ?? ''))
        ? optimisticCloudPin
        : cloudPin ?? null
    : null;
  const storedPinnedMessageId = usesCloudPins
    ? activeCloudPin?.effectiveMessageId ?? null
    : localPinIds[conversation.id] ?? null;
  const pinnedMessage = useMemo(() => {
    if (!storedPinnedMessageId) return null;
    return messages.find((message) => (
      usesCloudPins
        ? pinnedMessageCandidateIds(message, conversation.id).includes(storedPinnedMessageId)
        : chatMessageActionId(message) === storedPinnedMessageId
    )) ?? null;
  }, [conversation.id, messages, storedPinnedMessageId, usesCloudPins]);
  const pinnedMessageId = usesCloudPins || pinnedMessage
    ? storedPinnedMessageId
    : null;

  const requestPin = useCallback((message: Message) => {
    setPinForEveryone(false);
    setDialog({ mode: 'pin', message });
  }, []);
  const requestUnpin = useCallback((message: Message) => {
    setDialog({ mode: 'unpin', message });
  }, []);
  const openPinnedMessage = useCallback(() => {
    if (!pinnedMessageId) return;
    onNavigateToMessage(
      pinnedMessage ? chatMessageActionId(pinnedMessage) : pinnedMessageId,
    );
  }, [onNavigateToMessage, pinnedMessage, pinnedMessageId]);

  const confirmDialog = useCallback(() => {
    if (!dialog) return;
    const messageId = usesCloudPins
      ? stableCloudPinMessageId(dialog.message, conversation.id)
      : chatMessageActionId(dialog.message);
    const candidateIds = pinnedMessageCandidateIds(dialog.message, conversation.id);
    setDialog(null);
    if (!messageId) return;

    if (usesCloudPins && onUpdateCloudPin && sessionId) {
      const sharedMessageId = activeCloudPin?.sharedMessageId?.trim() ?? '';
      const scope = dialog.mode === 'pin'
        ? (pinForEveryone ? 'shared' : 'private')
        : sharedMessageId && candidateIds.includes(sharedMessageId)
          ? 'shared'
          : 'private';
      const nextMessageId = dialog.mode === 'pin' ? messageId : null;
      const base: CloudSessionPin = activeCloudPin ?? {
        sessionId,
        sharedMessageId: null,
        privateMessageId: null,
        effectiveMessageId: null,
        updatedAt: null,
      };
      const optimistic: CloudSessionPin = scope === 'shared'
        ? {
            ...base,
            sharedMessageId: nextMessageId,
            effectiveMessageId: base.privateMessageId || nextMessageId,
            updatedAt: new Date().toISOString(),
          }
        : {
            ...base,
            privateMessageId: nextMessageId,
            effectiveMessageId: nextMessageId || base.sharedMessageId,
            updatedAt: new Date().toISOString(),
          };
      setOptimisticCloudPins((current) => ({ ...current, [sessionId]: optimistic }));
      void onUpdateCloudPin({
        sessionId,
        messageId: nextMessageId,
        scope,
      }).then((pin) => {
        setOptimisticCloudPins((current) => ({ ...current, [pin.sessionId]: pin }));
      }).catch(() => {
        setOptimisticCloudPins((current) => {
          const next = { ...current };
          delete next[sessionId];
          return next;
        });
      });
      return;
    }

    setLocalPinIds((current) => ({
      ...current,
      [conversation.id]: dialog.mode === 'pin' ? messageId : null,
    }));
  }, [
    activeCloudPin,
    conversation.id,
    dialog,
    onUpdateCloudPin,
    pinForEveryone,
    sessionId,
    usesCloudPins,
  ]);

  return {
    pinnedMessageId,
    pinnedMessage,
    requestPin,
    requestUnpin,
    openPinnedMessage,
    dialog: {
      value: dialog,
      pinForEveryone,
      setPinForEveryone,
      cancel: () => setDialog(null),
      confirm: confirmDialog,
    },
  };
}

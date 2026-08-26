import { useCallback, useMemo, useState } from 'react';

import type { CloudSessionPin } from '@/features/cloud/authClient';
import {
  isCloudCollaborationConversationId,
  isCloudCollaborationHostId,
} from '@/features/cloud/cloudCollaborationState';
import type { Conversation, Message } from '@/kordi-app/types';
import {
  chatMessageActionId,
  type PinnedMessageItem,
  type PinnedMessageScope,
  pinnedMessageCandidateIds,
  stableCloudPinMessageId,
} from '@/pages/chatsPage.pinModel';

type PinDialog = {
  mode: 'pin' | 'unpin';
  message: Message;
  scope?: PinnedMessageScope;
};

function pinActorLabel(
  conversation: Conversation,
  accountId: string | null,
  currentAccountId?: string | null,
) {
  if (!accountId) return 'Someone';
  if (accountId === currentAccountId) return 'You';
  const participant = conversation.canonicalParticipants?.find((candidate) => (
    [candidate.id, candidate.sourceIdentityId, candidate.humanId].includes(accountId)
  ));
  const label = participant?.publicName?.trim() || participant?.name?.trim();
  return label?.toLowerCase() === 'me' ? 'You' : label || 'Someone';
}

type UseChatPinsInput = {
  conversation: Conversation;
  messages: readonly Message[];
  sessionId: string;
  isGroupSession: boolean;
  currentAccountId?: string | null;
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
  currentAccountId,
  cloudPin,
  onUpdateCloudPin,
  onNavigateToMessage,
}: UseChatPinsInput) {
  const [localPinIds, setLocalPinIds] = useState<Record<string, string | null>>({});
  const [localPinActivity, setLocalPinActivity] = useState<Record<string, string>>({});
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
  const pinnedMessages = useMemo<PinnedMessageItem[]>(() => {
    const pins: Array<{ messageId: string | null | undefined; scope: PinnedMessageScope }> = usesCloudPins
      ? [
          { messageId: activeCloudPin?.privateMessageId, scope: 'private' },
          { messageId: activeCloudPin?.sharedMessageId, scope: 'shared' },
        ]
      : [{ messageId: localPinIds[conversation.id], scope: 'private' }];
    return pins.flatMap(({ messageId, scope }) => {
      const normalizedId = messageId?.trim();
      if (!normalizedId) return [];
      const message = messages.find((candidate) => (
        usesCloudPins
          ? pinnedMessageCandidateIds(candidate, conversation.id).includes(normalizedId)
          : chatMessageActionId(candidate) === normalizedId
      ));
      return message ? [{ message, scope }] : [];
    });
  }, [activeCloudPin, conversation.id, localPinIds, messages, usesCloudPins]);
  const pinnedMessageIds = useMemo(
    () => [...new Set(pinnedMessages.map(({ message }) => chatMessageActionId(message)).filter(Boolean))],
    [pinnedMessages],
  );
  const pinActivityLabel = useMemo(() => {
    const action = activeCloudPin?.lastAction;
    if (!usesCloudPins || !action) return localPinActivity[conversation.id] ?? null;
    const actor = action.actorLabel?.trim()
      || pinActorLabel(conversation, action.updatedByAccountId, currentAccountId);
    return `${actor} ${action.kind} a message`;
  }, [activeCloudPin, conversation, currentAccountId, localPinActivity, usesCloudPins]);

  const requestPin = useCallback((message: Message) => {
    setPinForEveryone(false);
    setDialog({ mode: 'pin', message });
  }, []);
  const requestUnpin = useCallback((message: Message, scope?: PinnedMessageScope) => {
    setDialog({ mode: 'unpin', message, scope });
  }, []);
  const openPinnedMessage = useCallback((message: Message) => {
    const messageId = chatMessageActionId(message);
    if (messageId) onNavigateToMessage(messageId);
  }, [onNavigateToMessage]);

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
      const privateMessageId = activeCloudPin?.privateMessageId?.trim() ?? '';
      const scope = dialog.mode === 'pin'
        ? (pinForEveryone ? 'shared' : 'private')
        : dialog.scope
          ?? (privateMessageId && candidateIds.includes(privateMessageId)
            ? 'private'
            : sharedMessageId && candidateIds.includes(sharedMessageId)
              ? 'shared'
              : 'private');
      const nextMessageId = dialog.mode === 'pin' ? messageId : null;
      const base: CloudSessionPin = activeCloudPin ?? {
        sessionId,
        sharedMessageId: null,
        privateMessageId: null,
        effectiveMessageId: null,
        updatedAt: null,
      };
      const lastAction: NonNullable<CloudSessionPin['lastAction']> = {
        kind: dialog.mode === 'pin' ? 'pinned' : 'unpinned',
        scope,
        messageId: nextMessageId,
        updatedByAccountId: null,
        actorLabel: 'You',
        updatedAt: new Date().toISOString(),
      };
      const optimistic: CloudSessionPin = scope === 'shared'
        ? {
            ...base,
            sharedMessageId: nextMessageId,
            effectiveMessageId: base.privateMessageId || nextMessageId,
            updatedAt: lastAction.updatedAt,
            lastAction,
          }
        : {
            ...base,
            privateMessageId: nextMessageId,
            effectiveMessageId: nextMessageId || base.sharedMessageId,
            updatedAt: lastAction.updatedAt,
            lastAction,
          };
      setOptimisticCloudPins((current) => ({ ...current, [sessionId]: optimistic }));
      void onUpdateCloudPin({
        sessionId,
        messageId: nextMessageId,
        scope,
      }).then((pin) => {
        setOptimisticCloudPins((current) => ({
          ...current,
          [pin.sessionId]: { ...pin, lastAction },
        }));
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
    setLocalPinActivity((current) => ({
      ...current,
      [conversation.id]: `You ${dialog.mode === 'pin' ? 'pinned' : 'unpinned'} a message`,
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
    pinnedMessageIds,
    pinnedMessages,
    pinActivityLabel,
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

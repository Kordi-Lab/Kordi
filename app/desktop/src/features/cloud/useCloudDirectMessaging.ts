import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { flushSync } from 'react-dom';
import type {
  AttachmentItem,
} from '@/features/chat/composerController.types';
import type {
  MessageAttachment,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
  SendCloudVoiceMessageInput,
} from './authClient';
import {
  resolveForwardAttachmentItems,
  uploadComposerAttachments,
} from './cloudAttachments';
import {
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdForCollaborationSend,
} from './cloudCollaborationState';
import {
  cloudMessageMetadataOnly,
} from './cloudMessageCache';
import {
  deleteCloudMessageOptimistically,
  editCloudMessageOptimistically,
  rollbackCloudMessageDelete,
  rollbackCloudMessageEdit,
} from './cloudMessageMutations';
import { upsertCloudMessage } from './cloudMessageMerge';
import {
  cloudReactionMutationTargets,
  createCloudReactionMutationQueue,
  mergeCloudMessageReactionResponse,
  updateCloudMessageReaction,
  type CloudReactionMutation,
} from './cloudReactionMutations';
import {
  loadSession,
} from './session';

export type SendCloudCollaborationMessageOptions = {
  clientMessageId?: string | null;
  messageKind?: string | null;
  sharedTitle?: string | null;
  conversationKind?: 'ai' | 'direct' | 'group';
  memberAccountIds?: string[];
  voiceMessage?: SendCloudVoiceMessageInput | null;
};

export function useCloudDirectMessaging({
  account,
  client,
  messagesByPeerRef,
  setMessagesByPeer,
  syncDiff,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  messagesByPeerRef: MutableRefObject<Record<string, CloudMessage[]>>;
  setMessagesByPeer: Dispatch<
    SetStateAction<Record<string, CloudMessage[]>>
  >;
  syncDiff: () => Promise<void>;
}) {
  const [enqueueReactionMutation] = useState(createCloudReactionMutationQueue);
  const accountIdRef = useRef(account?.accountId ?? null);
  useEffect(() => {
    accountIdRef.current = account?.accountId ?? null;
  }, [account?.accountId]);
  const mergeMessage = useCallback((message: CloudMessage) => {
    const metadataMessage = cloudMessageMetadataOnly(message);
    const peerId =
      metadataMessage.fromAccountId === account?.accountId
        ? metadataMessage.toAccountId
        : metadataMessage.fromAccountId;
    if (!peerId) return;
    setMessagesByPeer((current) => {
      const previous = current[peerId] ?? [];
      const next = upsertCloudMessage(previous, metadataMessage);
      if (next === previous) return current;
      return { ...current, [peerId]: next };
    });
  }, [account?.accountId, setMessagesByPeer]);

  const editMessage = useCallback(async (input: {
    conversationId: string;
    messageId: string;
    expectedVersion: number;
    text: string;
  }) => {
    const accountId = account?.accountId ?? null;
    const sessionPromise = loadSession();
    const previous = messagesByPeerRef.current;
    const optimisticEditedAt = new Date().toISOString();
    flushSync(() => {
      setMessagesByPeer(editCloudMessageOptimistically(
        previous,
        input,
        optimisticEditedAt,
      ));
    });
    try {
      const session = await sessionPromise;
      if (!session?.token) throw new Error('Not signed in.');
      const message = await client.editMessage(
        session.token,
        input.conversationId,
        input.messageId,
        input.expectedVersion,
        input.text,
      );
      if (accountIdRef.current === accountId) mergeMessage(message);
      void syncDiff().catch(() => undefined);
      return message;
    } catch (error) {
      if (accountIdRef.current === accountId) {
        setMessagesByPeer((current) => rollbackCloudMessageEdit(
          current,
          previous,
          input,
          optimisticEditedAt,
        ));
      }
      throw error;
    }
  }, [account?.accountId, client, mergeMessage, messagesByPeerRef, setMessagesByPeer, syncDiff]);

  const deleteMessage = useCallback(async (input: {
    conversationId: string;
    messageId: string;
    forEveryone: boolean;
  }) => {
    const accountId = account?.accountId ?? null;
    const sessionPromise = loadSession();
    const previous = messagesByPeerRef.current;
    flushSync(() => {
      setMessagesByPeer(deleteCloudMessageOptimistically(previous, input));
    });
    try {
      const session = await sessionPromise;
      if (!session?.token) throw new Error('Not signed in.');
      await client.deleteMessage(
        session.token,
        input.conversationId,
        input.messageId,
        input.forEveryone,
      );
      void syncDiff().catch(() => undefined);
    } catch (error) {
      if (accountIdRef.current === accountId) {
        setMessagesByPeer((current) => rollbackCloudMessageDelete(current, previous, input));
      }
      throw error;
    }
  }, [account?.accountId, client, messagesByPeerRef, setMessagesByPeer, syncDiff]);

  const prepareForwardAttachments = useCallback(async (
    attachments: MessageAttachment[],
  ) => {
    if (attachments.length === 0) return [];
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    return resolveForwardAttachmentItems({
      token: session.token,
      client,
      attachments,
    });
  }, [client]);

  const sendMessage = useCallback(async (
    conversationId: string,
    text: string,
    attachments: AttachmentItem[] = [],
    options: SendCloudCollaborationMessageOptions = {},
  ) => {
    const peerId =
      cloudPeerAccountIdFromConversationId(conversationId);
    const trimmed = text.trim();
    if (!peerId || (!trimmed && attachments.length === 0)) {
      throw new Error('Unable to resolve cloud conversation.');
    }
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const uploadedAttachments = attachments.length > 0
      ? await uploadComposerAttachments({
          token: session.token,
          client,
          attachments,
        })
      : [];
    const voiceMessage = options.voiceMessage && uploadedAttachments[0]
      ? {
          ...options.voiceMessage,
          mediaId: uploadedAttachments[0].attachmentId,
        }
      : null;
    const cloudSessionId = cloudSessionIdForCollaborationSend(
      account?.accountId,
      peerId,
      conversationId,
    );
    const message = await client.sendMessage(
      session.token,
      peerId,
      trimmed,
      {
        sessionId: cloudSessionId,
        attachments: uploadedAttachments,
        clientMessageId: options.clientMessageId,
        messageKind: options.messageKind,
        voiceMessage,
        accountId: account?.accountId,
        sharedTitle: options.sharedTitle,
        conversationKind: options.conversationKind,
        memberAccountIds: options.memberAccountIds,
      },
    );
    mergeMessage(message);
    return message;
  }, [account?.accountId, client, mergeMessage]);

  const updateSessionTitle = useCallback(async (
    sessionId: string,
    title: string,
  ) => {
    const normalizedSessionId = sessionId.trim();
    const normalizedTitle = title.trim();
    if (!normalizedSessionId || !normalizedTitle) {
      throw new Error('A session and title are required.');
    }
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    return client.updateCloudSessionTitle(
      session.token,
      normalizedSessionId,
      {
        title: normalizedTitle,
        titleSource: 'auto',
        titleRevision: 1,
        titlePolicyVersion: 1,
        titleGeneratedFromMessageId: null,
        updatedAtMs: Date.now(),
      },
    );
  }, [client]);

  const setReaction = useCallback((input: CloudReactionMutation) => {
    const accountId = account?.accountId?.trim();
    if (!accountId) return Promise.reject(new Error('Not signed in.'));
    const sessionPromise = loadSession();
    const targets = cloudReactionMutationTargets(
      messagesByPeerRef.current,
      accountId,
      input,
    );
    const updateTargets = (
      current: Record<string, CloudMessage[]>,
      active: boolean,
      pending: boolean,
    ) => targets.reduce((next, target) => updateCloudMessageReaction(
      next,
      accountId,
      { ...target, active },
      pending,
    ), current);
    flushSync(() => {
      setMessagesByPeer((current) => updateTargets(current, input.active, true));
    });
    const key = [accountId, input.conversationId, input.messageId, input.reaction].join('\u0001');
    return enqueueReactionMutation(
      key,
      async () => {
        const session = await sessionPromise;
        if (!session?.token) throw new Error('Not signed in.');
        const messages = await Promise.all(targets.map((target) => client.setReaction(
          session.token,
          target.conversationId,
          target.messageId,
          target.reaction,
          target.active,
        )));
        void syncDiff().catch(() => undefined);
        return messages;
      },
      (messages) => {
        if (accountIdRef.current !== accountId) return;
        setMessagesByPeer((current) => messages.reduce((next, message, index) => (
          mergeCloudMessageReactionResponse(next, targets[index], message)
        ), current));
        messages.forEach(mergeMessage);
      },
      () => {
        if (accountIdRef.current !== accountId) return;
        setMessagesByPeer((current) => updateTargets(current, !input.active, false));
      },
    ).then((messages) => messages[0]);
  }, [account?.accountId, client, enqueueReactionMutation, mergeMessage, messagesByPeerRef, setMessagesByPeer, syncDiff]);

  return {
    deleteMessage,
    editMessage,
    mergeMessage,
    prepareForwardAttachments,
    sendMessage,
    setReaction,
    updateSessionTitle,
  };
}

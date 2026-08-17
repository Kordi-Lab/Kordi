import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';
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
import { upsertCloudMessage } from './cloudMessageMerge';
import {
  loadSession,
} from './session';

export type SendCloudCollaborationMessageOptions = {
  clientMessageId?: string | null;
  messageKind?: string | null;
  sharedTitle?: string | null;
  conversationKind?: 'ai' | 'direct' | 'group';
  memberAccountIds?: string[];
};

export function useCloudDirectMessaging({
  account,
  client,
  setMessagesByPeer,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  setMessagesByPeer: Dispatch<
    SetStateAction<Record<string, CloudMessage[]>>
  >;
}) {
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

  return {
    mergeMessage,
    prepareForwardAttachments,
    sendMessage,
    updateSessionTitle,
  };
}

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
import {
  loadSession,
} from './session';

export type SendCloudCollaborationMessageOptions = {
  clientMessageId?: string | null;
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
      if (
        previous.some(
          (candidate) =>
            candidate.messageId === metadataMessage.messageId,
        )
      ) return current;
      const next = [...previous, metadataMessage].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt),
      );
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
      },
    );
    mergeMessage(message);
  }, [account?.accountId, client, mergeMessage]);

  return {
    mergeMessage,
    prepareForwardAttachments,
    sendMessage,
  };
}

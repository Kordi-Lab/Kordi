import { livePhotoAttachmentIds } from '@/features/chat/livePhotos';
import type { CloudMessage, SendCloudMessageOptions } from './authClient';
import { cloudMessageFromChatSync, cloudOperationUuid, groupMemberAccountIdsFromEnvelope, chatTextContent } from './chatSyncMapping';
import { ChatSyncState } from './chatSyncState';
import type { ChatSyncMessage } from './chatSyncTypes';
import { isRetryableCloudDeliveryError } from './cloudAuthError';
import { completeChatSyncOutbox, dueChatSyncOutbox, enqueueChatSyncOutbox, failChatSyncOutbox } from '@/lib/desktopChatSync';
import { captureChatDeliveryScope, type ChatDeliveryScope } from './chatDeliveryScope';

const durableOutbox = {
  enqueue: enqueueChatSyncOutbox, due: dueChatSyncOutbox, complete: completeChatSyncOutbox, fail: failChatSyncOutbox,
};

export class ChatSyncMessageDelivery {
  constructor(private readonly state: ChatSyncState, private readonly outbox = durableOutbox) {}

  async sendMessage(
    token: string,
    peerAccountId: string,
    body: string,
    options: SendCloudMessageOptions = {},
    capturedScope?: ChatDeliveryScope,
  ): Promise<CloudMessage> {
    const attachments = options.attachments ?? [];
    const sessionId = options.sessionId?.trim() ?? '';
    const conversationKind = options.conversationKind
      ?? (body.startsWith('kordi-cloud-group:') ? 'group' : undefined);
    const envelopeMemberAccountIds = conversationKind === 'group'
      ? groupMemberAccountIdsFromEnvelope(body)
      : null;
    const conversationMemberAccountIds = envelopeMemberAccountIds ?? options.memberAccountIds;
    const accountId = options.accountId?.trim() || this.state.activeAccountId?.trim() || '';
    const deliveryScope = capturedScope ?? captureChatDeliveryScope(token, accountId);
    deliveryScope.assertCurrent();
    const stableGroupSession = sessionId || `${accountId}:${[...(options.memberAccountIds ?? [])].sort().join(':')}`;
    const clientMessageId = cloudOperationUuid(
      conversationKind === 'group'
        ? options.clientMessageId?.trim() || `group-message:${stableGroupSession}:${body}`
        : options.clientMessageId,
    );
    const messageKind = options.messageKind?.trim() || 'text';
    const historyLocalMessageId =
      options.canonicalHistoryLocalMessageId?.trim() ?? '';
    const historyCreatedAt = options.clientCreatedAt?.trim() ?? '';
    const canonicalHistory = messageKind.startsWith('canonical-history-')
      && historyLocalMessageId
      && Number.isFinite(Date.parse(historyCreatedAt))
      ? {
          localMessageId: historyLocalMessageId,
          originalCreatedAt: new Date(historyCreatedAt).toISOString(),
        }
      : null;
    const durableOptions: SendCloudMessageOptions = {
      ...options,
      accountId: accountId || options.accountId,
      clientMessageId,
      conversationKind,
      memberAccountIds: conversationMemberAccountIds,
    };
    const durablePeerAccountId = conversationKind === 'group'
      ? [...new Set(options.memberAccountIds ?? [])].map((value) => value.trim()).filter(Boolean).sort()[0]
        ?? peerAccountId.trim()
      : peerAccountId.trim();
    const durable = Boolean(accountId) && !options.transient;
    if (durable) {
      await this.outbox.enqueue(accountId, clientMessageId, {
        peerAccountId: durablePeerAccountId,
        body,
        options: durableOptions,
      }, deliveryScope.expectedOrganizationId);
    }
    try {
      deliveryScope.assertCurrent();
      const conversation = await this.state.ensureConversation(token, {
        peerAccountId,
        sessionId,
        kind: conversationKind,
        memberAccountIds: conversationMemberAccountIds,
        sharedTitle: options.sharedTitle,
        sourceGroupSpaceId: options.sourceGroupSpaceId,
        accountId,
        replaceMembers: envelopeMemberAccountIds !== null,
      });
      deliveryScope.assertCurrent();
      const response = await this.state.send<{ message: ChatSyncMessage }>(
        `/v2/chat/conversations/${encodeURIComponent(conversation.id)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...deliveryScope.headers },
          body: JSON.stringify({
            client_message_id: clientMessageId,
            kind: messageKind,
            content: chatTextContent(
              body,
              attachments,
              canonicalHistory,
              options.voiceMessage,
            ),
            reply_to_message_id: null,
            attachment_ids: [...new Set(attachments.flatMap(livePhotoAttachmentIds))],
          }),
        },
        'Could not send message.',
      );
      deliveryScope.assertCurrent();
      if (!response?.message) throw new Error('Empty response from chat sync server.');
      this.state.retainMessages([response.message]);
      const advancedConversation = {
        ...conversation,
        version: conversation.version + 1,
        latest_message_sequence: Math.max(
          conversation.latest_message_sequence,
          response.message.conversation_sequence,
        ),
      };
      this.state.rememberConversation(advancedConversation);
      if (durable) await this.outbox.complete(accountId, clientMessageId, deliveryScope.expectedOrganizationId);
      return cloudMessageFromChatSync(
        response.message,
        advancedConversation,
        accountId || conversation.preferences.account_id,
      );
    } catch (error) {
      deliveryScope.assertCurrent();
      if (durable) {
        await this.outbox.fail(
          accountId,
          clientMessageId,
          error instanceof Error ? error.message : 'Reliable chat send failed.',
          isRetryableCloudDeliveryError(error),
          deliveryScope.expectedOrganizationId,
        ).catch(() => {});
      }
      throw error;
    }
  }

  async drainChatOutbox(token: string, accountId: string): Promise<CloudMessage[]> {
    const deliveryScope = captureChatDeliveryScope(token, accountId);
    this.state.activeAccountId = accountId.trim() || this.state.activeAccountId;
    const pending = await this.outbox.due(accountId, deliveryScope.expectedOrganizationId);
    const delivered: CloudMessage[] = [];
    deliveryScope.assertCurrent();
    for (const operation of pending) {
      deliveryScope.assertCurrent();
      const payload = operation.payload;
      if (!payload?.peerAccountId || typeof payload.body !== 'string') {
        await this.outbox.fail(
          accountId,
          operation.operationId,
          'Stored reliable chat operation is invalid.',
          false,
          deliveryScope.expectedOrganizationId,
        );
        continue;
      }
      try {
        delivered.push(await this.sendMessage(
          token,
          payload.peerAccountId,
          payload.body,
          {
            ...(payload.options as SendCloudMessageOptions),
            accountId,
            clientMessageId: operation.operationId,
          },
          deliveryScope,
        ));
      } catch {
        deliveryScope.assertCurrent();
        // sendMessage records retry classification and backoff atomically.
      }
    }
    return delivered;
  }

}

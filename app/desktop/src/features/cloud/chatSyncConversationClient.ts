import type { CloudMessage, CloudSessionTitle, SendCloudMessageOptions, UpdateCloudSessionTitleInput } from './authClient';
import {
  cloudMessageFromChatSync,
  cloudOperationUuid,
  directSessionId,
  groupMemberAccountIdsFromEnvelope,
  inferConversationKind,
  chatTextContent,
} from './chatSyncMapping';
import { ChatSyncState } from './chatSyncState';
import type { ChatSyncConversation, ChatSyncMessage, ChatSyncPreferences } from './chatSyncTypes';
import { isRetryableCloudDeliveryError } from './cloudAuthError';
import { completeChatSyncOutbox, dueChatSyncOutbox, enqueueChatSyncOutbox, failChatSyncOutbox } from '@/lib/desktopChatSync';

export class ChatSyncConversationClient {
  constructor(private readonly state: ChatSyncState) {}

  async ensureChatConversation(token: string, input: {
    peerAccountId: string;
    sessionId?: string | null;
    kind?: ChatSyncConversation['kind'];
    memberAccountIds?: string[];
    sharedTitle?: string | null;
    accountId?: string | null;
    replaceMembers?: boolean;
  }): Promise<ChatSyncConversation> {
    const accountId = input.accountId?.trim() || this.state.activeAccountId?.trim() || '';
    const peerAccountId = input.peerAccountId.trim();
    const fallbackSessionId = accountId && peerAccountId
      ? directSessionId(accountId, peerAccountId)
      : '';
    const sessionId = input.sessionId?.trim() || fallbackSessionId;
    if (!sessionId) {
      throw new Error('A stable session id is required for reliable chat delivery.');
    }
    const kind = input.kind ?? inferConversationKind(accountId, peerAccountId, sessionId);
    const memberAccountIds = [...new Set(
      (input.memberAccountIds ?? [peerAccountId]).map((value) => value.trim()).filter(Boolean),
    )];
    const cached = this.state.conversationBySessionId.get(sessionId);
    if (cached) {
      if (cached.kind !== 'group') return cached;
      const activeMembers = new Set(cached.members
        .filter((member) => member.membership_state === 'active')
        .map((member) => member.account_id));
      const missing = memberAccountIds.filter((member) => !activeMembers.has(member));
      const removed = input.replaceMembers
        ? [...activeMembers].filter((member) => member !== accountId && !memberAccountIds.includes(member))
        : [];
      if (missing.length === 0 && removed.length === 0) return cached;
      const updated = await this.state.send<{ conversation: ChatSyncConversation }>(
        `/v2/chat/conversations/${encodeURIComponent(cached.id)}/members`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            client_operation_id: cloudOperationUuid(
              `members:${cached.id}:${cached.version}:${[...memberAccountIds].sort().join(':')}`,
            ),
            member_account_ids: input.replaceMembers ? memberAccountIds : missing,
            replace: input.replaceMembers === true,
          }),
        },
        'Could not synchronize group membership.',
      );
      if (!updated?.conversation) throw new Error('Empty response from chat sync server.');
      this.state.rememberConversation(updated.conversation);
      return updated.conversation;
    }
    const response = await this.state.send<{ conversation: ChatSyncConversation }>(
      '/v2/chat/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          client_operation_id: cloudOperationUuid([
            'conversation:chat',
            sessionId,
            kind,
            [...memberAccountIds].sort().join(','),
            input.sharedTitle?.trim() || '',
          ].join(':')),
          kind,
          shared_title: input.sharedTitle?.trim() || null,
          client_session_id: sessionId,
          member_account_ids: memberAccountIds,
        }),
      },
      'Could not open the reliable chat conversation.',
    );
    if (!response?.conversation) throw new Error('Empty response from chat sync server.');
    this.state.rememberConversation(response.conversation);
    return response.conversation;
  }

  async sendMessage(
    token: string,
    peerAccountId: string,
    body: string,
    options: SendCloudMessageOptions = {},
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
    const stableGroupSession = sessionId || `${accountId}:${[...(options.memberAccountIds ?? [])].sort().join(':')}`;
    const clientMessageId = cloudOperationUuid(
      conversationKind === 'group'
        ? `group-message:${stableGroupSession}:${body}`
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
    if (accountId) {
      await enqueueChatSyncOutbox(accountId, clientMessageId, {
        peerAccountId: durablePeerAccountId,
        body,
        options: durableOptions,
      });
    }
    try {
      const conversation = await this.state.ensureConversation(token, {
        peerAccountId,
        sessionId,
        kind: conversationKind,
        memberAccountIds: conversationMemberAccountIds,
        sharedTitle: options.sharedTitle,
        accountId,
        replaceMembers: envelopeMemberAccountIds !== null,
      });
      const response = await this.state.send<{ message: ChatSyncMessage }>(
        `/v2/chat/conversations/${encodeURIComponent(conversation.id)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            client_message_id: clientMessageId,
            kind: messageKind,
            content: chatTextContent(
              body,
              attachments,
              canonicalHistory,
            ),
            reply_to_message_id: null,
            attachment_ids: attachments.map((attachment) => attachment.attachmentId),
          }),
        },
        'Could not send message.',
      );
      if (!response?.message) throw new Error('Empty response from chat sync server.');
      this.state.messageById.set(response.message.id, response.message);
      const advancedConversation = {
        ...conversation,
        version: conversation.version + 1,
        latest_message_sequence: Math.max(
          conversation.latest_message_sequence,
          response.message.conversation_sequence,
        ),
      };
      this.state.rememberConversation(advancedConversation);
      if (accountId) await completeChatSyncOutbox(accountId, clientMessageId);
      return cloudMessageFromChatSync(
        response.message,
        advancedConversation,
        accountId || conversation.preferences.account_id,
      );
    } catch (error) {
      if (accountId) {
        await failChatSyncOutbox(
          accountId,
          clientMessageId,
          error instanceof Error ? error.message : 'Reliable chat send failed.',
          isRetryableCloudDeliveryError(error),
        ).catch(() => {});
      }
      throw error;
    }
  }

  async drainChatOutbox(token: string, accountId: string): Promise<CloudMessage[]> {
    this.state.activeAccountId = accountId.trim() || this.state.activeAccountId;
    const pending = await dueChatSyncOutbox(accountId);
    const delivered: CloudMessage[] = [];
    for (const operation of pending) {
      const payload = operation.payload;
      if (!payload?.peerAccountId || typeof payload.body !== 'string') {
        await failChatSyncOutbox(
          accountId,
          operation.operationId,
          'Stored reliable chat operation is invalid.',
          false,
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
        ));
      } catch {
        // sendMessage records retry classification and backoff atomically.
      }
    }
    return delivered;
  }

  async setReaction(
    token: string,
    conversationId: string,
    messageId: string,
    reaction: string,
    active: boolean,
  ): Promise<CloudMessage> {
    let conversation = this.state.conversationById.get(conversationId);
    if (!conversation) {
      await this.state.bootstrap(token);
      conversation = this.state.conversationById.get(conversationId);
    }
    if (!conversation) throw new Error('This conversation is unavailable for reliable chat sync.');
    const response = await this.state.send<{ message: ChatSyncMessage }>(
      `/v2/chat/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: active ? 'PUT' : 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ reaction }),
      },
      active ? 'Could not add the reaction.' : 'Could not remove the reaction.',
    );
    if (!response?.message) throw new Error('Empty response from chat sync server.');
    this.state.messageById.set(response.message.id, response.message);
    return cloudMessageFromChatSync(
      response.message,
      conversation,
      conversation.preferences.account_id,
    );
  }

  async markMessagesRead(token: string, peerAccountId: string): Promise<void> {
    const accountId = this.state.activeAccountId;
    if (!accountId) throw new Error('Cloud account identity is unavailable.');
    const conversation = await this.state.ensureConversation(token, {
      accountId,
      peerAccountId,
      sessionId: directSessionId(accountId, peerAccountId),
      kind: accountId === peerAccountId ? 'ai' : 'direct',
    });
    await this.advanceChatCursor(token, conversation, 'read');
  }

  async markSessionMessagesRead(token: string, sessionId: string): Promise<void> {
    let conversation = this.state.conversationBySessionId.get(sessionId.trim());
    if (!conversation) {
      await this.state.bootstrap(token);
      conversation = this.state.conversationBySessionId.get(sessionId.trim());
    }
    if (!conversation) throw new Error('Reliable chat conversation is unavailable.');
    await this.advanceChatCursor(token, conversation, 'read');
  }

  private async advanceChatCursor(
    token: string,
    conversation: ChatSyncConversation,
    kind: 'delivered' | 'read',
    sequence = conversation.latest_message_sequence,
  ): Promise<void> {
    if (sequence <= 0) return;
    await this.state.send(
      `/v2/chat/conversations/${encodeURIComponent(conversation.id)}/${kind}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          client_operation_id: cloudOperationUuid(`cursor:${kind}:${conversation.id}:${sequence}`),
          sequence,
        }),
      },
      `Could not mark messages ${kind}.`,
    );
  }

  async acknowledgeChatDelivery(
    token: string,
    conversationId: string,
    sequence: number,
  ): Promise<void> {
    const conversation = this.state.conversationById.get(conversationId);
    if (!conversation || sequence <= 0) return;
    await this.advanceChatCursor(token, conversation, 'delivered', sequence);
  }

  async updateCloudSessionTitle(token: string, sessionId: string, input: UpdateCloudSessionTitleInput): Promise<CloudSessionTitle> {
    let conversation = this.state.conversationBySessionId.get(sessionId.trim());
    if (!conversation) {
      await this.state.bootstrap(token);
      conversation = this.state.conversationBySessionId.get(sessionId.trim());
    }
    if (!conversation) throw new Error('Reliable chat conversation is unavailable.');
    const desiredTitle = input.title.trim() || null;
    const resultFrom = (
      target: ChatSyncConversation,
      preferences: ChatSyncPreferences,
    ): CloudSessionTitle => ({
      sessionId,
      title: preferences.personal_title ?? target.shared_title ?? input.title,
      titleSource: input.titleSource,
      titleRevision: preferences.version,
      titlePolicyVersion: input.titlePolicyVersion,
      titleGeneratedFromMessageId: input.titleGeneratedFromMessageId,
      updatedAtMs: input.updatedAtMs,
      updatedByAccountId: this.state.activeAccountId ?? preferences.account_id,
      updatedAt: new Date(input.updatedAtMs).toISOString(),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.state.send<{ preferences: ChatSyncPreferences }>(
          `/v2/chat/conversations/${encodeURIComponent(conversation.id)}/preferences`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
              client_operation_id: cloudOperationUuid(
                `title:${conversation.id}:${conversation.preferences.version}:${desiredTitle ?? ''}`,
              ),
              expected_preferences_version: conversation.preferences.version,
              personal_title: desiredTitle,
            }),
          },
          'Could not synchronize the session title.',
        );
        if (!response?.preferences) throw new Error('Empty response from chat sync server.');
        const updated = { ...conversation, preferences: response.preferences };
        this.state.rememberConversation(updated);
        return resultFrom(updated, response.preferences);
      } catch (error) {
        if (this.state.errorStatus(error) !== 409 || attempt > 0) {
          throw error;
        }
        await this.state.bootstrap(token);
        const refreshed = this.state.conversationBySessionId.get(sessionId.trim());
        if (!refreshed) throw error;
        conversation = refreshed;
        if (conversation.preferences.personal_title === desiredTitle) {
          return resultFrom(conversation, conversation.preferences);
        }
      }
    }
    throw new Error('Could not synchronize the session title.');
  }
}

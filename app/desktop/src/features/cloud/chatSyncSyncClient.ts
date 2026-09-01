import type { CloudSyncEvent, CloudSyncResponse } from './authClient';
import { normalizeCloudMessageSnapshot } from './cloudMessageSnapshot';
import { chatSyncSessionTitle, cloudMessageFromChatSync, directSessionId, conversationPeer } from './chatSyncMapping';
import { ChatSyncState } from './chatSyncState';
import type { ChatSyncBootstrapResponse, ChatSyncConversation, ChatSyncEvent, ChatSyncMessage, ChatSyncPreferences, ChatSyncSyncResponse } from './chatSyncTypes';

export class ChatSyncSyncClient {
  constructor(private readonly state: ChatSyncState) {}

  async syncCloudEvents(token: string, cursor: string, limit?: number): Promise<CloudSyncResponse> {
    const normalizedCursor = cursor.trim();
    if (!normalizedCursor || normalizedCursor === '0') {
      const bootstrap = await this.state.bootstrap(token);
      const events = this.chatBootstrapEvents(bootstrap);
      return {
        cursor: bootstrap.next_cursor,
        hasMore: false,
        events,
        chat: {
          bootstrap: true,
          protocolVersion: 2,
          nextCursor: bootstrap.next_cursor,
          lastStreamSeq: bootstrap.last_stream_seq,
          conversations: bootstrap.conversations,
          messages: bootstrap.latest_messages,
          events: [],
        },
      };
    }
    const params = new URLSearchParams({ cursor: normalizedCursor });
    if (limit !== undefined) params.set('limit', String(limit));
    let response: ChatSyncSyncResponse;
    try {
      response = await this.state.send<ChatSyncSyncResponse>(
        `/v2/chat/sync?${params.toString()}`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
        },
        'Could not sync reliable chat changes.',
      );
    } catch (error) {
      if (this.state.errorStatus(error) === 409) {
        return this.syncCloudEvents(token, '0', limit);
      }
      throw error;
    }
    const events = response.events.flatMap((event) => this.cloudEventsFromChatEvent(event));
    const conversations = response.events.flatMap((event) => {
      const conversation = event.payload.conversation;
      return conversation && typeof conversation === 'object' && !Array.isArray(conversation)
        ? [conversation as ChatSyncConversation]
        : [];
    });
    conversations.forEach((conversation) => this.state.rememberConversation(conversation));
    const messages = response.events.flatMap((event) => {
      const message = event.payload.message;
      return message && typeof message === 'object' && !Array.isArray(message)
        ? [message as ChatSyncMessage]
        : [];
    });
    messages.forEach((message) => this.state.messageById.set(message.id, message));
    return {
      cursor: response.next_cursor,
      hasMore: response.has_more,
      events,
      chat: {
        bootstrap: false,
        protocolVersion: 2,
        nextCursor: response.next_cursor,
        lastStreamSeq: response.last_stream_seq,
        conversations,
        messages,
        events: response.events,
      },
    };
  }

  async listMessageSnapshot(
    token: string,
    peerAccountId: string,
    limit?: number,
    viewerAccountId?: string | null,
  ) {
    const accountId = viewerAccountId?.trim() || this.state.activeAccountId;
    if (!accountId) throw new Error('Cloud account identity is unavailable.');
    this.state.activeAccountId = accountId;
    const conversation = await this.state.ensureConversation(token, {
      accountId,
      peerAccountId,
      sessionId: directSessionId(accountId, peerAccountId),
      kind: accountId === peerAccountId ? 'ai' : 'direct',
    });
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(Math.min(limit, 200)));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const response = await this.state.send<{
      messages: ChatSyncMessage[];
      next_before_sequence: number | null;
      has_more: boolean;
    }>(
      `/v2/chat/conversations/${encodeURIComponent(conversation.id)}/messages${suffix}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load reliable message history.',
    );
    const messages = response.messages
      .map((message) => cloudMessageFromChatSync(message, conversation, accountId))
      .sort((left, right) => (
        Number(left.conversationSequence ?? 0) - Number(right.conversationSequence ?? 0)
        || left.messageId.localeCompare(right.messageId)
      ));
    return normalizeCloudMessageSnapshot({
      messages,
      peerReadAt: null,
      chat: { conversation, messages: response.messages },
    });
  }

  async listChatConversationHistoryPage(
    token: string,
    conversationId: string,
    beforeSequence?: number,
    limit = 200,
  ): Promise<{
    messages: ChatSyncMessage[];
    nextBeforeSequence: number | null;
    hasMore: boolean;
  }> {
    const params = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 200)) });
    if (beforeSequence !== undefined) {
      if (!Number.isSafeInteger(beforeSequence) || beforeSequence <= 0) {
        throw new Error('Reliable chat history cursor is invalid.');
      }
      params.set('before_sequence', String(beforeSequence));
    }
    const response = await this.state.send<{
      messages: ChatSyncMessage[];
      next_before_sequence: number | null;
      has_more: boolean;
    }>(
      `/v2/chat/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not backfill reliable message history.',
    );
    response.messages.forEach((message) => this.state.messageById.set(message.id, message));
    return {
      messages: response.messages,
      nextBeforeSequence: response.next_before_sequence,
      hasMore: response.has_more,
    };
  }

  async bootstrapChatSync(token: string): Promise<ChatSyncBootstrapResponse> {
    const response = await this.state.send<ChatSyncBootstrapResponse>(
      '/v2/chat/sync/bootstrap',
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      'Could not bootstrap reliable chat state.',
    );
    if (response.protocol_version !== 2) {
      throw new Error('Unsupported reliable chat protocol version.');
    }
    this.state.rememberBootstrap(response);
    return response;
  }

  async issueChatSyncRealtimeTicket(token: string): Promise<{
    ticket: string;
    device_id: string;
    expires_at: string;
  }> {
    return this.state.send(
      '/v2/chat/realtime/ticket',
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
      'Could not open reliable realtime delivery.',
    );
  }

  private chatBootstrapEvents(bootstrap: ChatSyncBootstrapResponse): CloudSyncEvent[] {
    const conversationsById = new Map(bootstrap.conversations.map((value) => [value.id, value]));
    const conversationEvents = bootstrap.conversations.map((conversation) => ({
      eventId: `bootstrap:conversation:${conversation.id}:${conversation.version}`,
      eventType: 'session.title.updated',
      peerAccountId: null,
      messageId: null,
      payload: {
        sessionTitle: {
          sessionId: conversation.legacy_session_id ?? conversation.id,
          title: chatSyncSessionTitle(conversation),
          titleSource: conversation.preferences.personal_title ? 'manual' : 'external',
          titleRevision: conversation.version,
          titlePolicyVersion: 1,
          titleGeneratedFromMessageId: null,
          updatedAtMs: Date.parse(conversation.updated_at) || Date.now(),
          updatedByAccountId: conversation.created_by_account_id,
          updatedAt: conversation.updated_at,
        },
      },
      occurredAt: conversation.updated_at,
    } satisfies CloudSyncEvent));
    const messageEvents = bootstrap.latest_messages.flatMap((message) => {
      const conversation = conversationsById.get(message.conversation_id);
      if (!conversation) return [];
      return [{
        eventId: `bootstrap:message:${message.id}:${message.version}`,
        eventType: 'message.upsert',
        peerAccountId: conversationPeer(
          conversation,
          conversation.preferences.account_id,
          message.sender_account_id,
        ),
        messageId: message.id,
        payload: { message: cloudMessageFromChatSync(message, conversation) },
        occurredAt: message.created_at,
      } satisfies CloudSyncEvent];
    });
    const pinEvents = (bootstrap.session_pins ?? []).flatMap((pin) => (
      (['shared', 'private'] as const).map((scope) => {
        const messageId = scope === 'shared' ? pin.sharedMessageId : pin.privateMessageId;
        const updatedAt = pin.updatedAt ?? bootstrap.server_time;
        return {
          eventId: `bootstrap:session-pin:${pin.sessionId}:${scope}`,
          eventType: 'session.pin.updated',
          peerAccountId: null,
          messageId,
          payload: { sessionId: pin.sessionId, messageId, scope, updatedAt },
          occurredAt: updatedAt,
        } satisfies CloudSyncEvent;
      })
    ));
    return [...conversationEvents, ...messageEvents, ...pinEvents];
  }

  private cloudEventsFromChatEvent(event: ChatSyncEvent): CloudSyncEvent[] {
    const conversationValue = event.payload.conversation;
    const conversation = conversationValue && typeof conversationValue === 'object' && !Array.isArray(conversationValue)
      ? conversationValue as ChatSyncConversation
      : event.conversation_id
        ? this.state.conversationById.get(event.conversation_id) ?? null
        : null;
    if (conversation) this.state.rememberConversation(conversation);
    const base = {
      eventId: event.event_id,
      peerAccountId: null,
      messageId: event.entity_id,
      occurredAt: event.occurred_at,
    };
    if (event.type === 'call.created' || event.type === 'call.updated') {
      return [{
        ...base,
        eventType: event.type,
        payload: {
          ...event.payload,
          sessionId: conversation?.legacy_session_id ?? event.conversation_id,
        },
      }];
    }
    if (event.type === 'message.deleted' || event.type === 'message.hidden') {
      const messageId = event.entity_id?.trim();
      if (!messageId) return [];
      const previous = this.state.messageById.get(messageId);
      this.state.messageById.delete(messageId);
      return [{
        ...base,
        eventType: 'message.deleted',
        peerAccountId: previous && conversation
          ? conversationPeer(
              conversation,
              conversation.preferences.account_id,
              previous.sender_account_id,
            )
          : null,
        messageId,
        payload: { messageId },
      }];
    }
    if ([
      'message.created',
      'message.updated',
      'reaction.updated',
      'generation.updated',
      'generation.completed',
      'generation.failed',
    ].includes(event.type) && conversation) {
      const messageValue = event.payload.message;
      if (!messageValue || typeof messageValue !== 'object' || Array.isArray(messageValue)) return [];
      const message = messageValue as ChatSyncMessage;
      return [{
        ...base,
        eventType: 'message.upsert',
        peerAccountId: conversationPeer(
          conversation,
          conversation.preferences.account_id,
          message.sender_account_id,
        ),
        messageId: message.id,
        payload: {
          message: cloudMessageFromChatSync(message, conversation),
          ...(event.type === 'reaction.updated' ? { reactionStateConfirmed: true } : {}),
        },
      }];
    }
    if ((event.type === 'conversation.created'
      || event.type === 'conversation.updated'
      || event.type === 'membership.updated') && conversation) {
      return [{
        ...base,
        eventType: 'session.title.updated',
        payload: {
          sessionTitle: {
            sessionId: conversation.legacy_session_id ?? conversation.id,
            title: chatSyncSessionTitle(conversation),
            titleSource: conversation.preferences.personal_title ? 'manual' : 'external',
            titleRevision: conversation.version,
            titlePolicyVersion: 1,
            titleGeneratedFromMessageId: null,
            updatedAtMs: Date.parse(conversation.updated_at) || Date.now(),
            updatedByAccountId: conversation.created_by_account_id,
            updatedAt: conversation.updated_at,
          },
        },
      }];
    }
    if ([
      'account.profile.updated',
      'account.directory.changed',
      'agent.definition.upserted',
      'agent.definition.archived',
      'agent.directory.changed',
      'provider-auth.updated',
      'task.upsert',
      'artifact.upsert',
      'artifact.archived',
      'session.pin.updated',
      'session.hidden',
      'session.unhidden',
      'session.deleted',
      'session.pinned',
      'session.unpinned',
      'session.muted',
      'session.unmuted',
      'session.marked_unread',
      'session.unmarked_unread',
      'group_space.pinned',
      'group_space.unpinned',
      'session-forked',
      'device.added',
      'device.confirmed',
      'device.revoked',
      'device.renamed',
    ].includes(event.type)) {
      if (event.type === 'session.deleted' && typeof event.payload.sessionId === 'string') {
        this.state.forgetSession(event.payload.sessionId);
      }
      return [{
        ...base,
        eventType: event.type,
        payload: event.payload,
      }];
    }
    if (event.type === 'membership.removed' && event.conversation_id) {
      const sessionId = conversation?.legacy_session_id ?? event.conversation_id;
      this.state.conversationById.delete(event.conversation_id);
      if (conversation?.legacy_session_id) {
        this.state.conversationBySessionId.delete(conversation.legacy_session_id);
      }
      return [{
        ...base,
        eventType: 'session.deleted',
        payload: { sessionId },
      }];
    }
    if (event.type === 'conversation.preferences.updated' && conversation) {
      const preferences = event.payload.preferences;
      if (preferences && typeof preferences === 'object' && !Array.isArray(preferences)) {
        const updated = { ...conversation, preferences: preferences as ChatSyncPreferences };
        this.state.rememberConversation(updated);
        return [{
          ...base,
          eventType: 'session.title.updated',
          payload: {
            sessionTitle: {
              sessionId: updated.legacy_session_id ?? updated.id,
              title: chatSyncSessionTitle(updated),
              titleSource: updated.preferences.personal_title ? 'manual' : 'external',
              titleRevision: updated.preferences.version,
              titlePolicyVersion: 1,
              titleGeneratedFromMessageId: null,
              updatedAtMs: Date.parse(updated.updated_at) || Date.now(),
              updatedByAccountId: updated.preferences.account_id,
              updatedAt: updated.updated_at,
            },
          },
        }];
      }
    }
    if ((event.type === 'delivery_cursor.updated' || event.type === 'read_cursor.updated') && conversation) {
      const cursor = event.payload.cursor;
      if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
        const value = cursor as {
          account_id?: string;
          last_delivered_sequence?: number;
          last_read_sequence?: number;
        };
        const previousMember = conversation.members.find(
          (member) => member.account_id === value.account_id,
        );
        if (!previousMember) return [];
        const lastDeliveredSequence = Math.max(
          previousMember.last_delivered_sequence,
          value.last_delivered_sequence ?? previousMember.last_delivered_sequence,
        );
        const lastReadSequence = Math.max(
          previousMember.last_read_sequence,
          value.last_read_sequence ?? previousMember.last_read_sequence,
        );
        const updated = {
          ...conversation,
          members: conversation.members.map((member) => member.account_id === value.account_id
            ? {
              ...member,
              last_delivered_sequence: lastDeliveredSequence,
              last_read_sequence: lastReadSequence,
            }
            : member),
        };
        this.state.rememberConversation(updated);
        return [...this.state.messageById.values()]
          .filter((message) => message.conversation_id === updated.id && (
            (
              message.conversation_sequence > previousMember.last_delivered_sequence
              && message.conversation_sequence <= lastDeliveredSequence
            )
            || (
              message.conversation_sequence > previousMember.last_read_sequence
              && message.conversation_sequence <= lastReadSequence
            )
          ))
          .map((message) => ({
            ...base,
            eventId: `${event.event_id}:${message.id}`,
            eventType: 'message.upsert',
            peerAccountId: conversationPeer(
              updated,
              updated.preferences.account_id,
              message.sender_account_id,
            ),
            messageId: message.id,
            payload: { message: cloudMessageFromChatSync(message, updated) },
          }));
      }
    }
    return [];
  }
}

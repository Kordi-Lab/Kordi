import type { ApplyChatSyncRequest, ChatSyncLocalState, ChatSyncPendingOperation, ChatSyncOutboxPayload } from '@/lib/desktopChatSync';
import type { ChatSyncConversation, ChatSyncMessage, ChatSyncPreferences } from '@/features/cloud/chatSyncTypes';
import { browserCanonicalScope, updateBrowserStoredRecord } from '@web/runtime/browserCanonicalStorage';
import { chatSyncConversationHeads } from '@web/runtime/browserChatSyncUnread';

export type BrowserChatSyncState = ChatSyncLocalState & {
  deletedMessageIds: string[];
  outbox: ChatSyncPendingOperation[];
};

const SUPPORTED_EVENTS = new Set([
  'session.visibility.snapshot', 'conversation.created', 'conversation.updated', 'conversation.preferences.updated',
  'membership.updated', 'membership.removed', 'message.created', 'message.updated', 'message.deleted', 'message.hidden',
  'reaction.updated', 'delivery_cursor.updated', 'read_cursor.updated', 'generation.updated', 'generation.completed',
  'generation.failed', 'account.profile.updated', 'account.directory.changed', 'agent.definition.upserted',
  'agent.definition.archived', 'agent.directory.changed', 'provider-auth.updated', 'task.upsert', 'artifact.upsert',
  'artifact.archived', 'document.updated', 'session.pin.updated', 'session.hidden', 'session.unhidden', 'session.deleted',
  'session.pinned', 'session.unpinned', 'session.muted', 'session.unmuted', 'session.marked_unread', 'session.unmarked_unread',
  'group_space.pinned', 'group_space.unpinned', 'session-forked', 'call.created', 'call.updated',
  'device.added', 'device.confirmed', 'device.revoked', 'device.renamed',
]);

export function emptyBrowserChatSync(accountId: string): BrowserChatSyncState {
  return { accountId, cursor: null, lastStreamSeq: 0, conversations: [], messages: [],
    pinEvents: [], pinCacheReady: false, visibility: null, deletedMessageIds: [], outbox: [] };
}

function heads(state: BrowserChatSyncState, conversationIds?: ReadonlySet<string>) {
  return chatSyncConversationHeads(state.accountId,
    conversationIds ? state.conversations.filter(row => conversationIds.has(row.id)) : state.conversations,
    conversationIds ? state.messages.filter(row => conversationIds.has(row.conversation_id)) : state.messages);
}

export function applyBrowserChatSyncBatch(state: BrowserChatSyncState, request: ApplyChatSyncRequest) {
  if (state.accountId !== request.accountId) throw new Error('The chat account changed.');
  for (const event of request.events ?? []) {
    if (event.protocol_version !== 2) throw new Error('Unsupported chat sync protocol version. Reload Kordi.');
    if (event.critical && !SUPPORTED_EVENTS.has(event.type)) throw new Error('CLIENT_UPDATE_REQUIRED: Reload Kordi before continuing chat sync.');
  }
  const conversations = new Map(state.conversations.map(row => [row.id, row]));
  const messages = new Map(state.messages.map(row => [row.id, row]));
  const deleted = new Set(state.deletedMessageIds);
  const putConversation = (row: ChatSyncConversation) => {
    const previous = conversations.get(row.id);
    if (!previous || row.version >= previous.version) conversations.set(row.id, row);
  };
  const putMessage = (row: ChatSyncMessage) => {
    if (row.deleted_at) { deleted.add(row.id); messages.delete(row.id); return; }
    if (deleted.has(row.id)) return;
    const previous = messages.get(row.id);
    if (!previous || row.version >= previous.version) messages.set(row.id, row);
  };
  if (request.bootstrap) {
    state.pinCacheReady = true;
    const ids = new Set((request.conversations ?? []).map(row => row.id));
    state.pinEvents = (state.pinEvents ?? []).filter(event => !event.event_id.startsWith('bootstrap:')
      && (!event.conversation_id || ids.has(event.conversation_id)));
    for (const id of conversations.keys()) if (!ids.has(id)) conversations.delete(id);
    for (const [id, message] of messages) if (!ids.has(message.conversation_id)) messages.delete(id);
  }
  request.conversations?.forEach(putConversation);
  request.messages?.forEach(putMessage);
  for (const event of request.events ?? []) {
    const revokedIds = event.type === 'membership.removed' && event.payload.account_id === state.accountId && event.conversation_id
      ? [event.conversation_id]
      : event.type === 'session.deleted' ? [...conversations.values()]
        .filter(row => (row.legacy_session_id ?? row.id) === event.payload.sessionId).map(row => row.id) : [];
    if (revokedIds.length) {
      for (const id of revokedIds) {
        conversations.delete(id);
        for (const [messageId, row] of messages) if (row.conversation_id === id) messages.delete(messageId);
        state.pinEvents = (state.pinEvents ?? []).filter(event => event.conversation_id !== id);
      }
      continue;
    }
    if (event.payload.conversation) putConversation(event.payload.conversation as ChatSyncConversation);
    if (event.payload.message) putMessage(event.payload.message as ChatSyncMessage);
    if ((event.type === 'message.deleted' || event.type === 'message.hidden') && event.entity_id) {
      deleted.add(event.entity_id); messages.delete(event.entity_id);
    }
    const conversation = event.conversation_id ? conversations.get(event.conversation_id) : undefined;
    if (conversation && event.type === 'conversation.preferences.updated' && event.payload.preferences) {
      const preferences = event.payload.preferences as ChatSyncPreferences;
      if (preferences.version >= conversation.preferences.version) conversations.set(conversation.id, { ...conversation, preferences });
    }
    if (conversation && (event.type === 'delivery_cursor.updated' || event.type === 'read_cursor.updated') && event.payload.cursor) {
      const cursor = event.payload.cursor as { account_id: string; last_delivered_sequence?: number; last_read_sequence?: number };
      conversations.set(conversation.id, { ...conversation, members: conversation.members.map(member =>
        member.account_id === cursor.account_id ? { ...member,
          last_delivered_sequence: Math.max(member.last_delivered_sequence, cursor.last_delivered_sequence ?? 0),
          last_read_sequence: Math.max(member.last_read_sequence, cursor.last_read_sequence ?? 0) } : member) });
    }
    if (event.type === 'session.visibility.snapshot' && event.payload.visibility) {
      state.visibility = event.payload.visibility as ChatSyncLocalState['visibility'];
    }
    if (event.type === 'session.pin.updated') {
      state.pinEvents = [...(state.pinEvents ?? []).filter(row => row.event_id !== event.event_id), event];
      state.pinCacheReady = true;
    }
  }
  state.conversations = [...conversations.values()];
  state.messages = [...messages.values()];
  state.deletedMessageIds = [...deleted];
  if (request.cursor != null && (request.lastStreamSeq ?? state.lastStreamSeq) >= state.lastStreamSeq) state.cursor = request.cursor;
  state.lastStreamSeq = Math.max(state.lastStreamSeq, request.lastStreamSeq ?? 0);
  return { accountId: state.accountId, cursor: state.cursor, lastStreamSeq: state.lastStreamSeq,
    changedConversationHeads: heads(state, new Set((request.messages ?? []).map(row => row.conversation_id))) };
}

function messageRows(state: BrowserChatSyncState, conversationId: unknown) {
  return state.messages.filter(row => row.conversation_id === conversationId).sort((a, b) => a.conversation_sequence - b.conversation_sequence);
}

export function applyBrowserChatSyncCommand(state: BrowserChatSyncState, command: string, args: Record<string, unknown>, now = Date.now()): unknown {
  switch (command) {
    case 'desktop_chat_sync_load': return state;
    case 'desktop_chat_sync_cursor': return { accountId: state.accountId, cursor: state.cursor, lastStreamSeq: state.lastStreamSeq };
    case 'desktop_chat_sync_conversations': return state.conversations;
    case 'desktop_chat_sync_unread_counts': return heads(state);
    case 'desktop_chat_sync_coverage': return state.conversations.map(row => {
      const messages = messageRows(state, row.id);
      return { conversationId: row.id, earliestSequence: messages[0]?.conversation_sequence ?? 0,
        latestSequence: messages[messages.length - 1]?.conversation_sequence ?? 0, messageCount: messages.length };
    });
    case 'desktop_chat_sync_message_refs':
      return state.messages.filter(row => (args.conversationIds as string[]).includes(row.conversation_id))
        .map(({ id, client_message_id, conversation_id }) => ({ id, client_message_id, conversation_id }));
    case 'desktop_chat_sync_messages_page': {
      const limit = Math.min(500, Math.max(1, Number(args.limit ?? 100)));
      const rows = messageRows(state, args.conversationId).filter(row => row.conversation_sequence > Number(args.afterSequence ?? 0));
      const messages = rows.slice(0, limit);
      return { conversationId: args.conversationId, messages,
        nextAfterSequence: messages[messages.length - 1]?.conversation_sequence ?? null, hasMore: rows.length > limit };
    }
    case 'desktop_chat_sync_recovery_message_ids':
      return { conversationId: args.conversationId, messageIds: messageRows(state, args.conversationId).map(row => row.id) };
    case 'desktop_chat_sync_deleted_message_ids': return state.deletedMessageIds;
    case 'desktop_chat_sync_apply': return applyBrowserChatSyncBatch(state, args.request as ApplyChatSyncRequest);
    case 'desktop_chat_sync_outbox_enqueue': {
      const request = args.request as { accountId: string; operationId: string; payload: ChatSyncOutboxPayload };
      if (request.accountId !== state.accountId) throw new Error('The chat account changed.');
      if (!state.outbox.some(row => row.operationId === request.operationId)) state.outbox.push({ ...request, attemptCount: 0, nextAttemptAtMs: now, lastError: null });
      return;
    }
    case 'desktop_chat_sync_outbox_due': return state.outbox.filter(row => row.nextAttemptAtMs <= now);
    case 'desktop_chat_sync_outbox_complete': state.outbox = state.outbox.filter(row => row.operationId !== args.operationId); return;
    case 'desktop_chat_sync_outbox_fail': {
      const request = args.request as { operationId: string; error: string; retryable: boolean };
      const operation = state.outbox.find(row => row.operationId === request.operationId);
      if (!operation) return;
      operation.attemptCount += 1;
      operation.lastError = request.error;
      operation.nextAttemptAtMs = request.retryable ? now + Math.min(60_000, 1000 * 2 ** Math.min(operation.attemptCount, 6)) : Number.MAX_SAFE_INTEGER;
      return;
    }
    default: throw new Error('Unsupported browser chat storage operation.');
  }
}

const MUTATIONS = new Set(['desktop_chat_sync_apply', 'desktop_chat_sync_outbox_enqueue',
  'desktop_chat_sync_outbox_complete', 'desktop_chat_sync_outbox_fail']);

export async function runBrowserChatSyncCommand(accountId: string, organizationId: string | undefined,
  command: string, args: Record<string, unknown>) {
  const request = args.request as { accountId?: string; expectedOrganizationId?: string | null } | undefined;
  if ((args.accountId && args.accountId !== accountId) || (request?.accountId && request.accountId !== accountId)) {
    throw new Error('The chat account changed.');
  }
  if (command === 'desktop_chat_sync_apply' && (request?.expectedOrganizationId === undefined
    || request.expectedOrganizationId !== (organizationId ?? null))) {
    throw new Error('The organization changed while loading chat history. Refresh the conversation.');
  }
  if (command.startsWith('desktop_chat_sync_outbox_')) {
    const expected = request ? request.expectedOrganizationId : args.expectedOrganizationId;
    if (expected === undefined || expected !== (organizationId ?? null)) {
      throw new Error('The organization changed while sending this message. Return to its original workspace to retry.');
    }
  }
  return updateBrowserStoredRecord(`sync:${browserCanonicalScope(accountId, organizationId)}`,
    () => emptyBrowserChatSync(accountId), state => applyBrowserChatSyncCommand(state, command, args), !MUTATIONS.has(command));
}

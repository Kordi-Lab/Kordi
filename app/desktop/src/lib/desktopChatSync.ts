import type { ChatSyncConversation, ChatSyncEvent, ChatSyncMessage } from '@/features/cloud/authClient';
import { invokeDesktop, isNativeDesktopShell } from './desktop';

export type ChatSyncLocalState = {
  accountId: string;
  cursor: string | null;
  lastStreamSeq: number;
  conversations: ChatSyncConversation[];
  messages: ChatSyncMessage[];
};

export type ChatSyncCursorState = {
  accountId: string;
  cursor: string | null;
  lastStreamSeq: number;
};

export type ChatSyncConversationHead = {
  conversationId: string;
  latestMessageSequence: number;
};

export type ChatSyncApplyResult = ChatSyncCursorState & {
  changedConversationHeads: ChatSyncConversationHead[];
};

export type ChatSyncConversationCoverage = {
  conversationId: string;
  earliestSequence: number;
  latestSequence: number;
  messageCount: number;
};

export type ChatSyncMessageRef = Pick<
  ChatSyncMessage,
  'id' | 'client_message_id' | 'conversation_id'
>;

export type ChatSyncMessagePage = {
  conversationId: string;
  messages: ChatSyncMessage[];
  nextAfterSequence: number | null;
  hasMore: boolean;
};

export type ChatSyncRecoveryMessageIds = {
  conversationId: string;
  messageIds: string[];
};

export type ApplyChatSyncRequest = {
  accountId: string;
  bootstrap: boolean;
  cursor?: string | null;
  lastStreamSeq?: number | null;
  conversations?: ChatSyncConversation[];
  messages?: ChatSyncMessage[];
  events?: ChatSyncEvent[];
};

export type ChatSyncOutboxPayload = {
  peerAccountId: string;
  body: string;
  options: Record<string, unknown>;
};

export type ChatSyncPendingOperation = {
  accountId: string;
  operationId: string;
  payload: ChatSyncOutboxPayload;
  attemptCount: number;
  nextAttemptAtMs: number;
  lastError: string | null;
};

export async function loadChatSyncLocalState(accountId: string) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<ChatSyncLocalState>('desktop_chat_sync_load', { accountId });
}

export async function loadChatSyncCursor(accountId: string) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<ChatSyncCursorState>('desktop_chat_sync_cursor', { accountId });
}

export async function loadChatSyncCoverage(accountId: string) {
  if (!isNativeDesktopShell()) return [];
  return invokeDesktop<ChatSyncConversationCoverage[]>('desktop_chat_sync_coverage', { accountId });
}

export async function loadChatSyncConversations(accountId: string) {
  if (!isNativeDesktopShell()) return [];
  return invokeDesktop<ChatSyncConversation[]>('desktop_chat_sync_conversations', { accountId });
}

export async function loadChatSyncMessageRefs(accountId: string, conversationIds: string[]) {
  if (!isNativeDesktopShell() || conversationIds.length === 0) return [];
  return invokeDesktop<ChatSyncMessageRef[]>('desktop_chat_sync_message_refs', {
    accountId,
    conversationIds,
  });
}

export async function loadChatSyncMessagesPage(
  accountId: string,
  conversationId: string,
  afterSequence: number | null = null,
  limit = 100,
) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<ChatSyncMessagePage>('desktop_chat_sync_messages_page', {
    accountId,
    conversationId,
    afterSequence,
    limit,
  });
}

export async function loadChatSyncRecoveryMessageIds(
  accountId: string,
  conversationId: string,
) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<ChatSyncRecoveryMessageIds>(
    'desktop_chat_sync_recovery_message_ids',
    { accountId, conversationId },
  );
}

export async function applyChatSyncLocalBatch(request: ApplyChatSyncRequest) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<ChatSyncApplyResult>('desktop_chat_sync_apply', { request });
}

export async function enqueueChatSyncOutbox(
  accountId: string,
  operationId: string,
  payload: ChatSyncOutboxPayload,
) {
  if (!isNativeDesktopShell()) return;
  await invokeDesktop<void>('desktop_chat_sync_outbox_enqueue', {
    request: { accountId, operationId, payload },
  });
}

export async function dueChatSyncOutbox(accountId: string) {
  if (!isNativeDesktopShell()) return [];
  return invokeDesktop<ChatSyncPendingOperation[]>(
    'desktop_chat_sync_outbox_due',
    { accountId },
  );
}

export async function completeChatSyncOutbox(accountId: string, operationId: string) {
  if (!isNativeDesktopShell()) return;
  await invokeDesktop<void>('desktop_chat_sync_outbox_complete', { accountId, operationId });
}

export async function failChatSyncOutbox(
  accountId: string,
  operationId: string,
  error: string,
  retryable: boolean,
) {
  if (!isNativeDesktopShell()) return;
  await invokeDesktop<void>('desktop_chat_sync_outbox_fail', {
    request: { accountId, operationId, error, retryable },
  });
}

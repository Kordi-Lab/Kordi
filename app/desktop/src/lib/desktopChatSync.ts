import type { ChatSyncConversation, ChatSyncEvent, ChatSyncMessage } from '@/features/cloud/authClient';
import { invokeDesktop, isNativeDesktopShell } from './desktop';

export type ChatSyncLocalState = {
  accountId: string;
  cursor: string | null;
  lastStreamSeq: number;
  conversations: ChatSyncConversation[];
  messages: ChatSyncMessage[];
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

export async function applyChatSyncLocalBatch(request: ApplyChatSyncRequest) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<ChatSyncLocalState>('desktop_chat_sync_apply', { request });
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

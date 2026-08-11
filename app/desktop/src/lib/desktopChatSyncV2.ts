import type { ChatSyncV2Conversation, ChatSyncV2Event, ChatSyncV2Message } from '@/features/cloud/authClient';
import { invokeDesktop, isNativeDesktopShell } from './desktop';

export type ChatSyncV2LocalState = {
  accountId: string;
  cursor: string | null;
  lastStreamSeq: number;
  conversations: ChatSyncV2Conversation[];
  messages: ChatSyncV2Message[];
};

export type ApplyChatSyncV2Request = {
  accountId: string;
  bootstrap: boolean;
  cursor?: string | null;
  lastStreamSeq?: number | null;
  conversations?: ChatSyncV2Conversation[];
  messages?: ChatSyncV2Message[];
  events?: ChatSyncV2Event[];
};

export type ChatSyncV2OutboxPayload = {
  peerAccountId: string;
  body: string;
  options: Record<string, unknown>;
};

export type ChatSyncV2PendingOperation = {
  accountId: string;
  operationId: string;
  payload: ChatSyncV2OutboxPayload;
  attemptCount: number;
  nextAttemptAtMs: number;
  lastError: string | null;
};

export async function loadChatSyncV2LocalState(accountId: string) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<ChatSyncV2LocalState>('desktop_chat_sync_v2_load', { accountId });
}

export async function applyChatSyncV2LocalBatch(request: ApplyChatSyncV2Request) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<ChatSyncV2LocalState>('desktop_chat_sync_v2_apply', { request });
}

export async function enqueueChatSyncV2Outbox(
  accountId: string,
  operationId: string,
  payload: ChatSyncV2OutboxPayload,
) {
  if (!isNativeDesktopShell()) return;
  await invokeDesktop<void>('desktop_chat_sync_v2_outbox_enqueue', {
    request: { accountId, operationId, payload },
  });
}

export async function dueChatSyncV2Outbox(accountId: string) {
  if (!isNativeDesktopShell()) return [];
  return invokeDesktop<ChatSyncV2PendingOperation[]>(
    'desktop_chat_sync_v2_outbox_due',
    { accountId },
  );
}

export async function completeChatSyncV2Outbox(accountId: string, operationId: string) {
  if (!isNativeDesktopShell()) return;
  await invokeDesktop<void>('desktop_chat_sync_v2_outbox_complete', { accountId, operationId });
}

export async function failChatSyncV2Outbox(
  accountId: string,
  operationId: string,
  error: string,
  retryable: boolean,
) {
  if (!isNativeDesktopShell()) return;
  await invokeDesktop<void>('desktop_chat_sync_v2_outbox_fail', {
    request: { accountId, operationId, error, retryable },
  });
}

import type {
  ChatSyncConversation,
  ChatSyncMessage,
  CloudMessage,
} from './authClient';

export type CloudMessageSnapshot = {
  messages: CloudMessage[];
  peerReadAt: string | null;
  chat?: {
    conversation: ChatSyncConversation;
    messages: ChatSyncMessage[];
  };
};

export type CloudMessageSnapshotResponse = {
  messages?: CloudMessage[];
  peerReadAt?: string | null;
  chat?: CloudMessageSnapshot['chat'];
};

export function normalizeCloudMessageSnapshot(
  response: CloudMessageSnapshotResponse | null | undefined,
): CloudMessageSnapshot {
  return {
    messages: (response?.messages ?? []).map((message) => ({
      ...message,
      attachments: message.attachments ?? [],
    })),
    peerReadAt: typeof response?.peerReadAt === 'string'
      ? response.peerReadAt
      : null,
    ...(response?.chat ? { chat: response.chat } : {}),
  };
}

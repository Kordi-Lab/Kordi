import type {
  ChatSyncV2Conversation,
  ChatSyncV2Message,
  CloudMessage,
} from './authClient';

export type CloudMessageSnapshot = {
  messages: CloudMessage[];
  peerReadAt: string | null;
  v2?: {
    conversation: ChatSyncV2Conversation;
    messages: ChatSyncV2Message[];
  };
};

export type CloudMessageSnapshotResponse = {
  messages?: CloudMessage[];
  peerReadAt?: string | null;
  v2?: CloudMessageSnapshot['v2'];
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
    ...(response?.v2 ? { v2: response.v2 } : {}),
  };
}

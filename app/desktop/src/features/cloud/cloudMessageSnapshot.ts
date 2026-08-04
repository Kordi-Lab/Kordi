import type { CloudMessage } from './authClient';

export type CloudMessageSnapshot = {
  messages: CloudMessage[];
  peerReadAt: string | null;
};

export type CloudMessageSnapshotResponse = {
  messages?: CloudMessage[];
  peerReadAt?: string | null;
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
  };
}

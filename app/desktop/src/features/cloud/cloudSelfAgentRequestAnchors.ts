import type { CanonicalSessionMessage } from '@/kordi-app/types';
import type { CloudSelfAgentSyncLedger } from './cloudSelfAgentSyncLedger';

export function seedCloudSelfAgentRequestAnchors(
  canonicalMessages: readonly CanonicalSessionMessage[],
  requestSyncLedger: CloudSelfAgentSyncLedger,
  existingById: ReadonlyMap<string, CanonicalSessionMessage>,
) {
  const userTextByCloudMessageId = new Map<string, string>();
  const requestCreatedAtMsByCloudMessageId = new Map<string, number>();
  const requestLocalMessageIdByCloudMessageId =
    new Map<string, string>();
  const requestCloudIdentityByCloudMessageId = new Map<string, string>();
  for (const request of canonicalMessages) {
    if (request.senderRole !== 'user') continue;
    const content = request.content && typeof request.content === 'object' && !Array.isArray(request.content)
      ? request.content as Record<string, unknown> : {};
    const wireIds = [
      requestSyncLedger[request.id]?.cloudMessageId,
      request.sourceTransport === 'cloud-self-agent' ? request.sourceEventId : null,
      typeof content.desktopEntryId === 'string' ? content.desktopEntryId : null,
    ];
    for (const wireId of wireIds) {
      if (!wireId?.trim()) continue;
      const mappedId = requestLocalMessageIdByCloudMessageId.get(wireId);
      const mapped = mappedId ? existingById.get(mappedId) : null;
      if (mapped?.sourceTransport === 'desktop-chat-ui' && request.sourceTransport !== 'desktop-chat-ui') continue;
      userTextByCloudMessageId.set(wireId, request.contentText);
      requestCreatedAtMsByCloudMessageId.set(wireId, request.createdAtMs);
      requestLocalMessageIdByCloudMessageId.set(wireId, request.id);
      requestCloudIdentityByCloudMessageId.set(wireId, wireId);
    }
  }
  return { userTextByCloudMessageId, requestCreatedAtMsByCloudMessageId, requestLocalMessageIdByCloudMessageId, requestCloudIdentityByCloudMessageId };
}

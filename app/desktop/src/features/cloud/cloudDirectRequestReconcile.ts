import type { CloudAccount, CloudMessage } from './authClient';
import { parseCloudAgentCancel, parseCloudAgentResponse } from './cloudAgentMessages';
import { cloudDirectMessageTargetCloudAgentOwnerAccountId } from './cloudDirectMessages';
import type { CloudMessageIndex } from './cloudMessageIndex';

/** A request this account sent to another person's agent that has no final reply here yet. */
export type CloudDirectRequestAwaitingReply = {
  requestMessageId: string;
  ownerAccountId: string;
};

/**
 * Direct-chat requests this account sent to another person's agent, at least
 * `minAgeMs` old and inside `windowMs`, for which no final reply from that
 * owner is in the local store. The owner's Mac ends such a run by editing its
 * reply row; a viewer that missed that edit would otherwise keep showing the
 * request as waiting.
 */
export function cloudDirectRequestsAwaitingReply({
  account,
  messageIndex,
  nowMs,
  minAgeMs,
  windowMs,
}: {
  account: Pick<CloudAccount, 'accountId'>;
  messageIndex: Pick<CloudMessageIndex, 'byPeerId'>;
  nowMs: number;
  minAgeMs: number;
  windowMs: number;
}): CloudDirectRequestAwaitingReply[] {
  const accountId = account.accountId.trim();
  if (!accountId) return [];
  const awaiting: CloudDirectRequestAwaitingReply[] = [];
  for (const [peerId, messages] of messageIndex.byPeerId) {
    if (peerId === accountId) continue;
    const answered = answeredRequestKeys(messages);
    for (const message of messages) {
      if (message.fromAccountId !== accountId || message.deletedAt) continue;
      const ownerAccountId = cloudDirectMessageTargetCloudAgentOwnerAccountId(message.body)?.trim();
      if (!ownerAccountId || ownerAccountId === accountId) continue;
      const ageMs = nowMs - Date.parse(message.createdAt);
      if (!Number.isFinite(ageMs) || ageMs < minAgeMs || ageMs > windowMs) continue;
      if (answered.has(`${message.messageId}\u0000${ownerAccountId}`)) continue;
      if (answered.has(`${message.messageId}\u0000cancel`)) continue;
      awaiting.push({ requestMessageId: message.messageId, ownerAccountId });
    }
  }
  return awaiting;
}

function answeredRequestKeys(messages: readonly CloudMessage[]): Set<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    const response = parseCloudAgentResponse(message.body);
    if (response && !response.executionClaimId && response.deliveryState !== 'processing') {
      keys.add(`${response.requestId}\u0000${message.fromAccountId}`);
      continue;
    }
    const cancel = parseCloudAgentCancel(message.body);
    if (cancel) keys.add(`${cancel.requestId}\u0000cancel`);
  }
  return keys;
}

/** Whether a run status is final, so its reply is already stored on the server. */
export function cloudAgentRunStatusIsTerminal(status: string | null | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === 'completed' || normalized === 'failed' || normalized === 'cancelled';
}

import type { CloudMessage } from './authClient';
import {
  parseCloudAgentCancel,
  parseCloudAgentResponse,
} from './cloudAgentMessages';

const LEGACY_SELF_REPLAY_WINDOW_MS = 1_000;

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function selfReplayBaseKey(message: CloudMessage) {
  return [message.sessionId ?? '', message.body].join('\u001f');
}

function cloudMessageCreatedAtMs(message: CloudMessage) {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function replayTimesByBaseKey(messages: CloudMessage[]) {
  const timesByKey = new Map<string, number[]>();
  for (const message of messages) {
    if (message.fromAccountId !== message.toAccountId || message.attachments?.length) continue;
    const createdAtMs = cloudMessageCreatedAtMs(message);
    if (createdAtMs === null) continue;
    const key = selfReplayBaseKey(message);
    const times = timesByKey.get(key) ?? [];
    times.push(createdAtMs);
    timesByKey.set(key, times);
  }
  for (const times of timesByKey.values()) {
    times.sort((left, right) => left - right);
  }
  return timesByKey;
}

function sortedTimeInsertionIndex(times: number[], target: number) {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (times[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sortedTimesContainNear(times: number[] | undefined, target: number) {
  if (!times?.length) return false;
  const low = sortedTimeInsertionIndex(times, target);
  return (low < times.length
      && Math.abs(times[low] - target) < LEGACY_SELF_REPLAY_WINDOW_MS)
    || (low > 0
      && Math.abs(times[low - 1] - target) < LEGACY_SELF_REPLAY_WINDOW_MS);
}

function cloudAgentRequestId(message: CloudMessage) {
  return parseCloudAgentResponse(message.body)?.requestId
    ?? parseCloudAgentCancel(message.body)?.requestId
    ?? null;
}

export function selfSnapshotCurrentMessages(
  current: CloudMessage[],
  snapshot: CloudMessage[],
) {
  if (current.length === 0) return current;
  const snapshotIds = new Set(snapshot.map((message) => message.messageId));
  const referencedRequestIds = new Set([...current, ...snapshot].flatMap((message) => {
    const requestId = cloudAgentRequestId(message);
    return requestId ? [requestId] : [];
  }));
  const snapshotReplayTimes = replayTimesByBaseKey(snapshot);
  const hiddenReferencedRequestIds = new Set(current.flatMap((message) => {
    if (
      message.fromAccountId !== message.toAccountId
      || message.attachments?.length
      || snapshotIds.has(message.messageId)
      || !referencedRequestIds.has(message.messageId)
      || cloudAgentRequestId(message)
    ) return [];
    const createdAtMs = cloudMessageCreatedAtMs(message);
    if (createdAtMs === null) return [];
    return sortedTimesContainNear(
      snapshotReplayTimes.get(selfReplayBaseKey(message)),
      createdAtMs,
    ) ? [message.messageId] : [];
  }));
  const referencedReplayTimes = replayTimesByBaseKey(current.filter((message) => (
    message.fromAccountId === message.toAccountId
    && !message.attachments?.length
    && referencedRequestIds.has(message.messageId)
    && !hiddenReferencedRequestIds.has(message.messageId)
  )));
  const keptUnsnapshottedTimes = new Map<string, number[]>();
  const retained = current.filter((message) => {
    if (
      message.fromAccountId !== message.toAccountId
      || message.attachments?.length
      || snapshotIds.has(message.messageId)
    ) return true;
    if (hiddenReferencedRequestIds.has(message.messageId)) return false;
    const requestId = cloudAgentRequestId(message);
    if (requestId && hiddenReferencedRequestIds.has(requestId)) return false;
    if (referencedRequestIds.has(message.messageId)) return true;
    const createdAtMs = cloudMessageCreatedAtMs(message);
    if (createdAtMs === null) return true;
    const key = selfReplayBaseKey(message);
    if (sortedTimesContainNear(referencedReplayTimes.get(key), createdAtMs)) return false;
    if (sortedTimesContainNear(snapshotReplayTimes.get(key), createdAtMs)) return false;
    const keptTimes = keptUnsnapshottedTimes.get(key) ?? [];
    if (sortedTimesContainNear(keptTimes, createdAtMs)) return false;
    const insertionIndex = sortedTimeInsertionIndex(keptTimes, createdAtMs);
    keptTimes.splice(insertionIndex, 0, createdAtMs);
    keptUnsnapshottedTimes.set(key, keptTimes);
    return true;
  });
  return retained.length === current.length ? current : retained;
}

export function collapseLegacySelfMessageReplays(messages: CloudMessage[]) {
  if (messages.length < 2) return messages;
  const referencedRequestIds = new Set(messages.flatMap((message) => {
    const requestId = parseCloudAgentResponse(message.body)?.requestId
      ?? parseCloudAgentCancel(message.body)?.requestId;
    return requestId ? [requestId] : [];
  }));
  const replayKey = (message: CloudMessage) => [
    message.sessionId ?? '',
    message.body,
    message.createdAt,
  ].join('\u001f');
  const preferredIdByReplayKey = new Map<string, string>();
  for (const message of messages) {
    if (
      message.fromAccountId !== message.toAccountId
      || message.attachments?.length
      || !referencedRequestIds.has(message.messageId)
    ) continue;
    const key = replayKey(message);
    if (!preferredIdByReplayKey.has(key)) {
      preferredIdByReplayKey.set(key, message.messageId);
    }
  }
  for (const message of messages) {
    if (
      message.fromAccountId !== message.toAccountId
      || message.attachments?.length
    ) continue;
    const key = replayKey(message);
    if (!preferredIdByReplayKey.has(key)) {
      preferredIdByReplayKey.set(key, message.messageId);
    }
  }
  const retained = messages.filter((message) => {
    if (
      message.fromAccountId !== message.toAccountId
      || message.attachments?.length
      || referencedRequestIds.has(message.messageId)
    ) return true;
    return preferredIdByReplayKey.get(replayKey(message))
      === message.messageId;
  });
  return retained.length === messages.length ? messages : retained;
}

export function collapseLegacyCloudSelfMessageReplaysByPeer(
  messagesByPeer: Record<string, CloudMessage[]>,
  accountId: string | null | undefined,
): Record<string, CloudMessage[]> {
  const selfAccountId = cleanText(accountId);
  if (!selfAccountId) return messagesByPeer;
  const current = messagesByPeer[selfAccountId] ?? [];
  const collapsed = collapseLegacySelfMessageReplays(current);
  return collapsed === current
    ? messagesByPeer
    : { ...messagesByPeer, [selfAccountId]: collapsed };
}

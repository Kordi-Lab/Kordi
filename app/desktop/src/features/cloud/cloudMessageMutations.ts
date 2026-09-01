import type { CloudMessage } from './authClient';
import {
  encodeCloudDirectMessageEnvelope,
  parseCloudDirectMessageEnvelope,
} from './cloudDirectMessages';
import {
  encodeCloudGroupControl,
  parseCloudGroupControl,
} from './cloudGroupMessages';
import { compareCloudMessages } from './cloudMessageMerge';

type CloudMessageMutationTarget = {
  conversationId: string;
  messageId: string;
};

function matchesMutationTarget(
  message: CloudMessage,
  input: CloudMessageMutationTarget,
) {
  return message.conversationId?.trim() === input.conversationId.trim()
    && [message.messageId, message.clientMessageId].includes(input.messageId.trim());
}

function editedMessageBody(body: string, text: string) {
  const group = parseCloudGroupControl(body);
  if (group?.message) {
    return encodeCloudGroupControl({
      ...group,
      message: { ...group.message, text },
    });
  }
  const direct = parseCloudDirectMessageEnvelope(body);
  return direct
    ? encodeCloudDirectMessageEnvelope({ ...direct, text })
    : text;
}

export function editCloudMessageOptimistically(
  messagesByPeer: Record<string, CloudMessage[]>,
  input: CloudMessageMutationTarget & { expectedVersion: number; text: string },
  editedAt: string,
): Record<string, CloudMessage[]> {
  let changed = false;
  const next = Object.fromEntries(Object.entries(messagesByPeer).map(([peerId, messages]) => {
    let peerChanged = false;
    const updated = messages.map((message) => {
      if (!matchesMutationTarget(message, input) || message.version !== input.expectedVersion) {
        return message;
      }
      changed = true;
      peerChanged = true;
      return {
        ...message,
        body: editedMessageBody(message.body, input.text),
        version: input.expectedVersion + 1,
        editedAt,
      };
    });
    return [peerId, peerChanged ? updated : messages];
  }));
  return changed ? next : messagesByPeer;
}

export function rollbackCloudMessageEdit(
  current: Record<string, CloudMessage[]>,
  previous: Record<string, CloudMessage[]>,
  input: CloudMessageMutationTarget & { expectedVersion: number },
  optimisticEditedAt: string,
): Record<string, CloudMessage[]> {
  let changed = false;
  const next = Object.fromEntries(Object.entries(current).map(([peerId, messages]) => {
    const originals = new Map(
      (previous[peerId] ?? [])
        .filter((message) => matchesMutationTarget(message, input))
        .map((message) => [message.messageId, message]),
    );
    let peerChanged = false;
    const restored = messages.map((message) => {
      const original = originals.get(message.messageId);
      if (
        !original
        || message.version !== input.expectedVersion + 1
        || message.editedAt !== optimisticEditedAt
      ) return message;
      changed = true;
      peerChanged = true;
      return original;
    });
    return [peerId, peerChanged ? restored : messages];
  }));
  return changed ? next : current;
}

export function deleteCloudMessageOptimistically(
  messagesByPeer: Record<string, CloudMessage[]>,
  input: CloudMessageMutationTarget,
): Record<string, CloudMessage[]> {
  let changed = false;
  const next = Object.fromEntries(Object.entries(messagesByPeer).map(([peerId, messages]) => {
    const retained = messages.filter((message) => !matchesMutationTarget(message, input));
    changed ||= retained.length !== messages.length;
    return [peerId, retained.length === messages.length ? messages : retained];
  }));
  return changed ? next : messagesByPeer;
}

export function rollbackCloudMessageDelete(
  current: Record<string, CloudMessage[]>,
  previous: Record<string, CloudMessage[]>,
  input: CloudMessageMutationTarget,
): Record<string, CloudMessage[]> {
  let next = current;
  for (const [peerId, messages] of Object.entries(previous)) {
    const originals = messages.filter((message) => matchesMutationTarget(message, input));
    const currentMessages = next[peerId] ?? [];
    const missing = originals.filter((original) => (
      !currentMessages.some((message) => message.messageId === original.messageId)
    ));
    if (missing.length === 0) continue;
    next = {
      ...next,
      [peerId]: [...currentMessages, ...missing].sort(compareCloudMessages),
    };
  }
  return next;
}

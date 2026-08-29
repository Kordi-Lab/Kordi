import type { CloudMessage } from './authClient';
import { parseCloudGroupControl } from './cloudGroupMessages';
import {
  cloudReactionsEqual,
  mergeCloudMessageMonotonicState,
  normalizeCloudMessageReactions,
} from './cloudMessageMerge';

export type CloudReactionMutation = {
  conversationId: string;
  messageId: string;
  reaction: string;
  active: boolean;
};

export function cloudReactionMutationTargets(
  messagesByPeer: Record<string, CloudMessage[]>,
  accountId: string,
  input: CloudReactionMutation,
): CloudReactionMutation[] {
  const messages = Object.values(messagesByPeer).flat();
  const selected = messages.find((message) => (
    [message.conversationId, message.sessionId].includes(input.conversationId)
    && [message.messageId, message.clientMessageId].includes(input.messageId)
  ));
  const selectedTarget = selected?.conversationId
    ? { ...input, conversationId: selected.conversationId, messageId: selected.messageId }
    : input;
  if (input.active || !selected) return [selectedTarget];
  const selectedEnvelope = parseCloudGroupControl(selected.body);
  const logicalMessageId = selectedEnvelope?.message?.id;
  if (!logicalMessageId) return [selectedTarget];
  // ponytail: scan the loaded session only on reaction removal; index logical
  // group-message ids if this compatibility fan-out becomes a hot path.
  const targets = messages.flatMap((message) => {
    if (message.sessionId !== selected.sessionId || !message.conversationId) return [];
    const envelope = parseCloudGroupControl(message.body);
    const reacted = message.reactions?.some((reaction) => (
      reaction.value === input.reaction && reaction.accountIds.includes(accountId)
    ));
    return envelope?.groupId === selectedEnvelope.groupId
      && envelope.message?.id === logicalMessageId
      && reacted
      ? [{ ...input, conversationId: message.conversationId, messageId: message.messageId }]
      : [];
  });
  return targets.length > 0
    ? [...new Map(targets.map((target) => (
        [`${target.conversationId}\u0000${target.messageId}`, target]
      ))).values()]
    : [selectedTarget];
}

export function updateCloudMessageReaction(
  messagesByPeer: Record<string, CloudMessage[]>,
  accountId: string,
  input: CloudReactionMutation,
  pending = true,
): Record<string, CloudMessage[]> {
  let changed = false;
  const next = Object.fromEntries(Object.entries(messagesByPeer).map(([peerId, messages]) => {
    let peerChanged = false;
    const updated = messages.map((message) => {
      if (
        message.conversationId?.trim() !== input.conversationId.trim()
        || ![message.messageId, message.clientMessageId].includes(input.messageId.trim())
      ) return message;
      const reactions = normalizeCloudMessageReactions(message.reactions) ?? [];
      const accountIds = new Set(
        reactions.find((reaction) => reaction.value === input.reaction)?.accountIds ?? [],
      );
      if (input.active) accountIds.add(accountId);
      else accountIds.delete(accountId);
      const updatedReactions = normalizeCloudMessageReactions([
        ...reactions.filter((reaction) => reaction.value !== input.reaction),
        ...(accountIds.size > 0 ? [{ value: input.reaction, accountIds: [...accountIds] }] : []),
      ]) ?? [];
      const previousIntents = message.pendingReactionIntents ?? [];
      const pendingReactionIntents = [
        ...previousIntents.filter((intent) => (
          intent.value !== input.reaction || intent.accountId !== accountId
        )),
        ...(pending ? [{ value: input.reaction, accountId, active: input.active }] : []),
      ];
      const intentsChanged = previousIntents.length !== pendingReactionIntents.length
        || previousIntents.some((intent, index) => {
          const next = pendingReactionIntents[index];
          if (!next) return true;
          return intent.value !== next.value
            || intent.accountId !== next.accountId
            || intent.active !== next.active;
        });
      if (!intentsChanged && cloudReactionsEqual(reactions, updatedReactions)) return message;
      peerChanged = true;
      return {
        ...message,
        reactions: updatedReactions,
        pendingReactionIntents: pendingReactionIntents.length > 0
          ? pendingReactionIntents
          : undefined,
      };
    });
    changed ||= peerChanged;
    return [peerId, peerChanged ? updated : messages];
  }));
  return changed ? next : messagesByPeer;
}

export function mergeCloudMessageReactionResponse(
  messagesByPeer: Record<string, CloudMessage[]>,
  input: CloudReactionMutation,
  authoritative: CloudMessage,
): Record<string, CloudMessage[]> {
  let changed = false;
  const next = Object.fromEntries(Object.entries(messagesByPeer).map(([peerId, messages]) => {
    let peerChanged = false;
    const updated = messages.map((message) => {
      if (
        message.messageId !== authoritative.messageId
        && (
          message.conversationId?.trim() !== input.conversationId.trim()
          || ![message.messageId, message.clientMessageId].includes(input.messageId.trim())
        )
      ) return message;
      const merged = mergeCloudMessageMonotonicState(message, authoritative, {
        confirmReactionState: true,
      });
      if (merged === message) return message;
      peerChanged = true;
      return merged;
    });
    changed ||= peerChanged;
    return [peerId, peerChanged ? updated : messages];
  }));
  return changed ? next : messagesByPeer;
}

export function createCloudReactionMutationQueue() {
  let revision = 0;
  const pending = new Map<string, { revision: number; tail: Promise<unknown> }>();
  return <T>(
    key: string,
    mutate: () => Promise<T>,
    commit: (value: T) => void,
    rollback: () => void,
  ): Promise<T> => {
    const mutationRevision = ++revision;
    const previous = pending.get(key)?.tail ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      try {
        const message = await mutate();
        if (pending.get(key)?.revision === mutationRevision) commit(message);
        return message;
      } catch (error) {
        if (pending.get(key)?.revision === mutationRevision) rollback();
        throw error;
      }
    });
    const result = queued.finally(() => {
      if (pending.get(key)?.tail === result) pending.delete(key);
    });
    pending.set(key, { revision: mutationRevision, tail: result });
    return result;
  };
}

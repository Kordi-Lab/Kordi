import { isCollaborationLiveTurnId } from '@/features/collaboration/legacyBridgeCompatibility';
import type { Message } from '@/kordi-app/types';
import { localRuntimeProgressForCanonicalPlaceholder } from '../localRuntimeProgress';
import { comparableToolSignature, sameOwnedAgentTurn } from '../runtimeTurnMatching';
import { comparableAgentResponseText, messageResponseText } from './runtimeMessageMatching';

function isLegacyCollaborationProcessingOnlyRuntimePlaceholder(message: Message) {
  if (!isCollaborationLiveTurnId(message.id) || !message.turn) return false;
  return !message.turn.completed
    && !message.text.trim()
    && !message.turn.assistantText.trim()
    && !message.turn.thinkingText.trim()
    && message.turn.tools.length === 0;
}

function hasLocalOwnedAgentRuntimeStatus(message: Message) {
  return message.role === 'owned-agent'
    && Boolean(message.turn)
    && !isLegacyCollaborationProcessingOnlyRuntimePlaceholder(message)
    && (
      (message.turn?.tools?.length ?? 0) > 0
      || (message.turn?.thinkingText?.trim().length ?? 0) > 0
      || message.turn?.completed === false
    );
}

function isPendingCanonicalAgentPlaceholder(message: Message) {
  return Boolean(
    message.turn
      && !message.turn.completed
      && (message.role === 'owned-agent' || message.role === 'external-agent')
      && message.id?.startsWith('canonical-delegation-processing:'),
  );
}

function ownedAgentTurnMatchKeys(message: Message) {
  if (message.role !== 'owned-agent') return [];
  const keys: string[] = [];
  const responseText = messageResponseText(message);
  if (responseText) keys.push(`text:${comparableAgentResponseText(responseText)}`);
  const tools = comparableToolSignature(message);
  if (tools) keys.push(`tools:${tools}`);
  const thinking = message.turn?.thinkingText?.trim() ?? '';
  if (thinking) keys.push(`thinking:${comparableAgentResponseText(thinking)}`);
  return keys;
}

export function mergeLocalOwnedAgentRuntimeStatus(
  canonicalMessages: Message[],
  existingMessages: Message[],
) {
  const merged = [...canonicalMessages];
  const canonicalIndexesByMatchKey = new Map<string, number[]>();
  const indexMessage = (message: Message, index: number) => {
    for (const key of ownedAgentTurnMatchKeys(message)) {
      const indexes = canonicalIndexesByMatchKey.get(key);
      if (indexes) indexes.push(index);
      else canonicalIndexesByMatchKey.set(key, [index]);
    }
  };
  merged.forEach(indexMessage);

  const pendingCanonicalIndexesByRole = new Map<Message['role'], number[]>();
  merged.forEach((message, index) => {
    if (!isPendingCanonicalAgentPlaceholder(message)) return;
    const indexes = pendingCanonicalIndexesByRole.get(message.role);
    if (indexes) indexes.push(index);
    else pendingCanonicalIndexesByRole.set(message.role, [index]);
  });

  for (const localMessage of existingMessages.filter(hasLocalOwnedAgentRuntimeStatus)) {
    if (localMessage.turn && !localMessage.turn.completed) {
      const pendingCanonicalIndex = (pendingCanonicalIndexesByRole.get(localMessage.role) ?? [])
        .find((index) => isPendingCanonicalAgentPlaceholder(merged[index]));
      if (pendingCanonicalIndex !== undefined) {
        merged[pendingCanonicalIndex] = localRuntimeProgressForCanonicalPlaceholder(
          merged[pendingCanonicalIndex],
          localMessage,
        );
        indexMessage(merged[pendingCanonicalIndex], pendingCanonicalIndex);
        continue;
      }
    }

    const candidateIndexes = new Set<number>();
    for (const key of ownedAgentTurnMatchKeys(localMessage)) {
      for (const index of canonicalIndexesByMatchKey.get(key) ?? []) candidateIndexes.add(index);
    }
    const matchingCanonicalIndex = [...candidateIndexes]
      .sort((left, right) => left - right)
      .find((index) => sameOwnedAgentTurn(merged[index], localMessage));
    if (matchingCanonicalIndex !== undefined) {
      merged[matchingCanonicalIndex] = localMessage;
      indexMessage(localMessage, matchingCanonicalIndex);
    } else {
      const nextIndex = merged.length;
      merged.push(localMessage);
      indexMessage(localMessage, nextIndex);
    }
  }
  return merged;
}

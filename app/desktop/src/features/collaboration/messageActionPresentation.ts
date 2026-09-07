import type { Message } from '@/kordi-app/types';

export function realSourceLabelForRelativeLabel(label: string, humanSourceLabel: string, agentSourceLabel: string) {
  const trimmed = label.trim();
  const normalized = trimmed.toLowerCase();
  if ((normalized === 'me' || normalized === 'you') && humanSourceLabel.trim()) {
    return humanSourceLabel.trim();
  }
  if (normalized === 'my kordi' && agentSourceLabel.trim()) {
    return agentSourceLabel.trim();
  }
  return trimmed;
}

export function collaborationMessageActionWithRealSourceLabel(
  action: Message['messageAction'],
  humanSourceLabel: string,
  agentSourceLabel: string,
): Message['messageAction'] {
  if (!action) return null;
  const senderLabel = realSourceLabelForRelativeLabel(action.source.senderLabel, humanSourceLabel, agentSourceLabel);
  if (senderLabel === action.source.senderLabel) return action;
  return {
    ...action,
    source: {
      ...action.source,
      senderLabel,
    },
  };
}

export function collaborationMessageActionSourceReference(action: Message['messageAction']): Message['sourceMessage'] {
  if (!action || action.kind === 'thread') return null;
  return {
    messageId: action.source.sourceMessageId,
    senderLabel: action.source.senderLabel,
    text: action.source.textPreview,
    mentions: action.source.mentions,
    attachmentCount: action.source.attachmentCount,
    time: action.source.timeLabel ?? null,
  };
}

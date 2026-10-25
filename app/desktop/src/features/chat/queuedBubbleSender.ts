import type { TranscriptDensityMode } from '@/kordi-app/components/transcript';

/**
 * The name above a queued request drawn in the transcript. Another person's
 * queued message always names them. Your own follows the sent bubble's rule:
 * only where your sent messages show a name, never on a grouped follow-up and
 * not in compact one-to-one density. A queued bubble that shows a name the
 * sent bubble drops changes height when it becomes active.
 */
export function queuedBubbleSenderLabel(
  message: { sender?: string; showSenderMeta?: boolean },
  own: boolean,
  densityMode: TranscriptDensityMode | undefined,
  groupedWithPrevious: boolean,
): string | undefined {
  if (!own) return message.sender;
  const compactHidesSender = Boolean(densityMode && densityMode !== 'default' && densityMode !== 'group-compact');
  return message.showSenderMeta && message.sender && !groupedWithPrevious && !compactHidesSender ? message.sender : undefined;
}

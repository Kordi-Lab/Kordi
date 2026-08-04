import type { Message } from '@/kordi-app/types';

function clean(value?: string | null) {
  return value?.trim() ?? '';
}

export function compactTranscriptNavigationIds(
  values: Array<string | null | undefined>,
) {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const normalized = clean(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

export function transcriptMessageVisibleId(message: Message) {
  return clean(message.id) || clean(message.entryId) || clean(message.turn?.id);
}

export function transcriptMessageNavigationIds(message: Message) {
  return compactTranscriptNavigationIds([
    message.id,
    message.entryId,
    message.turn?.id,
    message.turn?.transcriptEntryId,
    ...(message.replyAliasIds ?? []),
  ]);
}

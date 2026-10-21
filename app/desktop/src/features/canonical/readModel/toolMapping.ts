import type { DesktopChatToolSnapshot } from '@/kordi-app/types';
import { contentRecord, stringValue } from './messageContent';

export function canonicalTools(value: unknown): DesktopChatToolSnapshot[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item, index) => {
    const record = contentRecord(item);
    const name = stringValue(record.name);
    if (!name) return [];

    return [{
      id: stringValue(record.id) ?? `canonical-tool-${index}`,
      name,
      status: stringValue(record.status) ?? 'done',
      arguments: stringValue(record.arguments) ?? '',
      liveOutput: stringValue(record.liveOutput) ?? '',
      resultText: stringValue(record.resultText) ?? null,
      detail: stringValue(record.detail) ?? null,
      artifactPath: stringValue(record.artifactPath) ?? null,
      toolLayer: stringValue(record.toolLayer) ?? null,
      isError: Boolean(record.isError),
    }];
  });
}

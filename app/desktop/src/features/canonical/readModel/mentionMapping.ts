import {
  compatibleSourceHostId,
  normalizeCollaborationTargetKind,
} from '@/features/collaboration/legacyBridgeCompatibility';
import type { MessageMention } from '@/kordi-app/types';

function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

export function canonicalMentions(value: unknown): MessageMention[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const mentions = value.flatMap((item) => {
    const record = contentRecord(item);
    const label = stringValue(record.label)?.trim();
    if (!label) return [];
    return [{
      label,
      targetKind: normalizeCollaborationTargetKind(record.targetKind),
      sourceHostId: compatibleSourceHostId(record) ?? null,
      nodeId: stringValue(record.nodeId) ?? null,
      humanId: stringValue(record.humanId) ?? null,
      agentId: stringValue(record.agentId) ?? null,
      displayLabel: stringValue(record.displayLabel)?.trim() || null,
    }];
  });
  return mentions.length > 0 ? mentions : undefined;
}

import type { CloudMessage } from './authClient';
import {
  parseCloudGroupControl,
  type CloudGroupControlKind,
} from './cloudGroupMessages';

export type LegacyCloudGroupTitleNoticeClassification = {
  cloudMessageId: string;
  sourceControlKind: 'group-invite' | 'group-update' | 'group-title-update';
};

export function legacyCloudGroupTitleNoticeClassifications(
  candidateMessageIds: string[],
  messages: Array<Pick<CloudMessage, 'messageId' | 'body'>>,
): LegacyCloudGroupTitleNoticeClassification[] {
  const bodyByMessageId = new Map(messages.map((message) => [message.messageId.trim(), message.body]));
  const seen = new Set<string>();
  const classifications: LegacyCloudGroupTitleNoticeClassification[] = [];
  for (const rawMessageId of candidateMessageIds) {
    const cloudMessageId = rawMessageId.trim();
    if (!cloudMessageId || seen.has(cloudMessageId)) continue;
    seen.add(cloudMessageId);
    const body = bodyByMessageId.get(cloudMessageId);
    if (!body) continue;
    const envelope = parseCloudGroupControl(body);
    if (!envelope || !matchesLegacyTitleNoticeControl(envelope.kind)) continue;
    classifications.push({ cloudMessageId, sourceControlKind: envelope.kind });
  }
  return classifications;
}

function matchesLegacyTitleNoticeControl(
  kind: CloudGroupControlKind,
): kind is LegacyCloudGroupTitleNoticeClassification['sourceControlKind'] {
  return kind === 'group-invite' || kind === 'group-update' || kind === 'group-title-update';
}

import type { CanonicalSessionMessage } from '@/kordi-app/types';
import { invokeDesktop, isNativeDesktopShell } from '@/lib/desktop';
import type { LegacyCloudGroupTitleNoticeClassification } from './legacyCloudGroupTitleNotices';

export type { LegacyCloudGroupTitleNoticeClassification } from './legacyCloudGroupTitleNotices';

export type LegacyCloudGroupTitleNoticeClassificationDelta = {
  messages: CanonicalSessionMessage[];
  sessionRepairs: Array<{
    sessionId: string;
    lastMessageAtMs: number | null;
    replacedThroughAtMs: number;
  }>;
};

export async function listLegacyCloudGroupTitleNoticeIds() {
  if (!isNativeDesktopShell()) return [];
  return invokeDesktop<string[]>('desktop_canonical_list_legacy_cloud_group_title_notice_ids');
}

export async function classifyLegacyCloudGroupTitleNotices(
  requests: LegacyCloudGroupTitleNoticeClassification[],
): Promise<LegacyCloudGroupTitleNoticeClassificationDelta> {
  if (!isNativeDesktopShell() || requests.length === 0) {
    return { messages: [], sessionRepairs: [] };
  }
  const messages: CanonicalSessionMessage[] = [];
  const sessionRepairById = new Map<string, LegacyCloudGroupTitleNoticeClassificationDelta['sessionRepairs'][number]>();
  for (let index = 0; index < requests.length; index += 500) {
    const delta = await invokeDesktop<LegacyCloudGroupTitleNoticeClassificationDelta>(
      'desktop_canonical_classify_legacy_cloud_group_title_notices',
      { requests: requests.slice(index, index + 500) },
    );
    messages.push(...delta.messages);
    delta.sessionRepairs.forEach((repair) => sessionRepairById.set(repair.sessionId, repair));
  }
  return { messages, sessionRepairs: [...sessionRepairById.values()] };
}

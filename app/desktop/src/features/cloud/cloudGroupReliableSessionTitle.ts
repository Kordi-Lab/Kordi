import { deriveSessionTitle } from '@/features/chat/sessionTitlePolicy';
import type { CloudAuthClient } from './authClient';
import type { CloudMessageIndex } from './cloudMessageIndex';
import type { SendCloudGroupControlInput } from './cloudGroupControl.types';

export function reliableCloudGroupSessionTitle({
  input,
  messageIndex,
  manualTitle,
  accountId,
}: {
  input: SendCloudGroupControlInput;
  messageIndex: CloudMessageIndex;
  manualTitle: ReliableSessionTitle | null;
  accountId: string;
}): ReliableSessionTitle | null {
  if (manualTitle) return manualTitle;
  if (input.kind !== 'group-message') return null;
  const title = messageIndex.legacyGroupSessionTitlesById.get(input.groupId)
    ?? deriveSessionTitle(input.message?.text ?? '');
  return title ? {
    title,
    titleSource: 'auto',
    titleRevision: 1,
    titlePolicyVersion: 1,
    updatedAtMs: input.message?.createdAtMs ?? Date.now(),
    updatedByAccountId: accountId,
  } : null;
}

export async function persistReliableCloudGroupSessionTitle({
  client,
  token,
  input,
  title,
  reportWarning,
}: {
  client: CloudAuthClient;
  token: string;
  input: SendCloudGroupControlInput;
  title: ReliableSessionTitle | null;
  reportWarning: (message: string, error: unknown) => void;
}) {
  if (!title) return;
  await client.updateCloudSessionTitle(token, input.groupId, {
    title: title.title,
    titleSource: title.titleSource,
    titleRevision: title.titleRevision,
    titlePolicyVersion: title.titlePolicyVersion,
    titleGeneratedFromMessageId: title.titleSource === 'auto' ? input.message?.id ?? null : null,
    updatedAtMs: title.updatedAtMs,
  }).catch((error) => reportWarning(
    '[cloud-group-session-title] failed to persist reliable title',
    error,
  ));
}
type ReliableSessionTitle = {
  title: string;
  titleSource: 'manual' | 'auto';
  titleRevision: number;
  titlePolicyVersion: number;
  updatedAtMs: number;
  updatedByAccountId?: string;
};

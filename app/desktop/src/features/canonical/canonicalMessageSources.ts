import { invokeDesktop, isNativeDesktopShell } from '@/lib/desktop';

export type CanonicalMessageSourceRef = {
  sourceTransport: string;
  sourceEventId: string;
};

export async function fetchExistingCanonicalMessageSources(
  sources: readonly CanonicalMessageSourceRef[],
) {
  if (!isNativeDesktopShell() || sources.length === 0) return [];
  return invokeDesktop<CanonicalMessageSourceRef[]>(
    'desktop_canonical_existing_message_sources',
    { sources },
  );
}

export async function deleteCanonicalCloudMessage(cloudMessageId: string) {
  if (!isNativeDesktopShell()) return [];
  return invokeDesktop<string[]>('desktop_canonical_delete_cloud_message', {
    cloudMessageId,
  });
}

export async function pruneMissingCanonicalCloudMessages(accountId: string) {
  if (!isNativeDesktopShell()) return [];
  return invokeDesktop<string[]>('desktop_canonical_prune_missing_cloud_messages', {
    accountId,
  });
}

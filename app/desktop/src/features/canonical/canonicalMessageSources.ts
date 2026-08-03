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

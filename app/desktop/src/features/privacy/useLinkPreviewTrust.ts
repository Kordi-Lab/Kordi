import { useMemo } from 'react';

import type { CloudAccount } from '@/features/cloud/authClient';
import { useCloudContacts } from '@/features/cloud/useCloudContacts';

import { trustedLinkPreviewHumanIds } from './linkPreviewPolicy';

/**
 * Trusted link-preview senders for the signed-in account. Reads the shared
 * contacts store that the Contacts screen uses, so it adds no extra polling,
 * but only its `serverContacts` rows: the latest contacts response, replaced
 * on every refresh. Realtime contact hints never grant trust.
 */
export function useLinkPreviewTrust(cloudAccount: CloudAccount | null | undefined): ReadonlySet<string> {
  const { serverContacts } = useCloudContacts(cloudAccount ?? null);
  const selfAccountId = cloudAccount?.accountId ?? null;
  return useMemo(
    () => trustedLinkPreviewHumanIds({ selfAccountId, serverContacts }),
    [serverContacts, selfAccountId],
  );
}

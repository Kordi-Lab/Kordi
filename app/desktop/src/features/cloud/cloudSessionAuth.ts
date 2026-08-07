import {
  activateDesktopCloudAccountStorage,
  restoreDesktopCloudProviderAuth,
  type DesktopCloudAccountStorageActivation,
} from '@/lib/desktop';
import type { CloudAccount, CloudAuthResult } from './authClient';
import type { StoredSession } from './session';

export const CLOUD_PROVIDER_AUTH_UPDATED_EVENT = 'kordi-cloud-provider-auth-updated';
const CLOUD_PROVIDER_AUTH_UPDATED_SUBJECT_PREFIX = 'kordi.events.account.provider_auth.updated.';

export function shouldRestoreCloudProviderAuthForWsSubject(
  subject: string | undefined | null,
  accountId: string | undefined | null,
): boolean {
  const cleanAccountId = accountId?.trim();
  return Boolean(
    cleanAccountId
    && subject === `${CLOUD_PROVIDER_AUTH_UPDATED_SUBJECT_PREFIX}${cleanAccountId}`
  );
}

type ProviderAuthRestore = (accountId: string) => Promise<{
  restoredProfiles: number;
  removedProfiles?: number;
  selectionChanged?: boolean;
}>;

type CompleteCloudAuthResultOptions = {
  result: CloudAuthResult;
  currentAccountId: string | null;
  saveSession?: (session: StoredSession) => Promise<void>;
  activateAccountStorage?: (
    accountId: string,
  ) => Promise<DesktopCloudAccountStorageActivation>;
  restoreAccountProviderAuth?: ProviderAuthRestore;
  setAuthenticated: (account: CloudAccount) => void;
  reloadWindow?: () => void;
};

async function providerAuthRestoreChanged(
  accountId: string,
  restore: ProviderAuthRestore,
): Promise<boolean> {
  try {
    const result = await restore(accountId);
    return result.restoredProfiles > 0
      || (result.removedProfiles ?? 0) > 0
      || result.selectionChanged === true;
  } catch {
    // Provider restoration is best-effort; account sign-in must remain usable
    // when the server has no snapshot or requires a newer login session.
    return false;
  }
}

export async function completeCloudAuthResult({
  result,
  currentAccountId,
  saveSession: persistSession,
  activateAccountStorage = activateDesktopCloudAccountStorage,
  restoreAccountProviderAuth = restoreDesktopCloudProviderAuth,
  setAuthenticated: publishAuthenticated,
  reloadWindow,
}: CompleteCloudAuthResultOptions): Promise<boolean> {
  const session: StoredSession = {
    token: result.session.token,
    accountId: result.account.accountId,
    expiresAt: result.session.expiresAt,
  };
  if (persistSession) await persistSession(session);
  const activation = await activateAccountStorage(result.account.accountId);
  const providerAuthChanged = await providerAuthRestoreChanged(
    result.account.accountId,
    restoreAccountProviderAuth,
  );
  const switchedAccount = Boolean(
    activation.storageRoot
    && currentAccountId
    && currentAccountId !== result.account.accountId,
  );
  if (activation.requiresReload || switchedAccount || providerAuthChanged) {
    reloadWindow?.();
    return false;
  }
  publishAuthenticated(result.account);
  return true;
}

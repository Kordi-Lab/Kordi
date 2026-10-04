import { isPipAccountId } from '@/features/pip/pipIdentity';
import { KORDI_SUPPORT_ACCOUNT_ID } from '@/features/support/supportIdentity';

/** Kordi-operated accounts: they cannot be blocked and are not reported here. */
export function isServiceAccountId(accountId: string | null | undefined): boolean {
  const id = accountId?.trim() ?? '';
  return isPipAccountId(id) || id === KORDI_SUPPORT_ACCOUNT_ID;
}

/** The account id behind a canonical `human:<account>` identity, if any. */
export function humanIdentityAccountId(identityId: string | null | undefined): string | null {
  const id = identityId?.trim() ?? '';
  if (!id.startsWith('human:')) return null;
  const accountId = id.slice('human:'.length).trim();
  return accountId.startsWith('acct_') ? accountId : null;
}

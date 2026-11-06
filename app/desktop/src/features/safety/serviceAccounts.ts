import { KORDI_SUPPORT_ACCOUNT_ID } from '@/features/support/supportIdentity';
import {
  KORDI_SYSTEM_ACCOUNT_ID,
  KORDI_SYSTEM_AGENT_ACCOUNT_ID,
  KORDI_SYSTEM_AGENT_CLOUD_AGENT_ID,
  isBuiltInAccountId,
} from '@/features/systemAgent/systemAgentIdentity';

const SERVICE_IDS = [KORDI_SUPPORT_ACCOUNT_ID, KORDI_SYSTEM_ACCOUNT_ID, KORDI_SYSTEM_AGENT_ACCOUNT_ID, KORDI_SYSTEM_AGENT_CLOUD_AGENT_ID];

/** Kordi-operated accounts: they cannot be blocked or reported here. */
export function isServiceAccountId(accountId: string | null | undefined): boolean {
  const id = accountId?.trim() ?? '';
  return isBuiltInAccountId(id) || id === KORDI_SUPPORT_ACCOUNT_ID;
}

/** Whether a canonical sender identity (`human:…`, `agent:cloud:…`) is a Kordi-operated one. */
export function isServiceIdentityId(identityId: string | null | undefined): boolean {
  const id = identityId?.trim() ?? '';
  return Boolean(id) && SERVICE_IDS.some((serviceId) => id === serviceId || id.endsWith(`:${serviceId}`));
}

/** The account id behind a `human:<account>` identity or a bare account id. */
export function humanIdentityAccountId(identityId: string | null | undefined): string | null {
  const id = identityId?.trim() ?? '';
  const accountId = id.startsWith('human:') ? id.slice('human:'.length).trim() : id;
  return accountId.startsWith('acct_') ? accountId : null;
}

import { browserSessionAccountId } from '@web/auth/browserAppRuntime';
import { cachedSessionSnapshot } from './session';

export type ChatDeliveryScope = {
  expectedOrganizationId?: string | null;
  headers: Record<string, string>;
  assertCurrent(): void;
};

/** Browser markers survive workspace switches, so durable delivery must bind
 * its network requests and local acknowledgements to the captured workspace. */
export function captureChatDeliveryScope(token: string, accountId: string): ChatDeliveryScope {
  const browserAccountId = browserSessionAccountId(token);
  if (!browserAccountId) return { headers: {}, assertCurrent() {} };
  const session = cachedSessionSnapshot();
  const organizationId = session?.organizationId ?? null;
  const assertCurrent = () => {
    const current = cachedSessionSnapshot();
    if (!session || browserAccountId !== session.accountId || (accountId && accountId !== session.accountId)
      || current?.accountId !== session.accountId || (current.organizationId ?? null) !== organizationId) {
      throw new Error('The organization changed while sending this message. Return to its original workspace to retry.');
    }
  };
  assertCurrent();
  return { expectedOrganizationId: organizationId, headers: { 'Kordi-Organization': organizationId ?? '' }, assertCurrent };
}

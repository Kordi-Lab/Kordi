import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { captureChatDeliveryScope } from '@/features/cloud/chatDeliveryScope';
import { cachedSessionSnapshot, loadSession } from '@/features/cloud/session';

/** A browser rename commits the hosted preference before changing its local projection. */
export async function persistBrowserSessionTitle(accountId: string, sessionId: string, title: string) {
  const original = cachedSessionSnapshot();
  if (!original || original.accountId !== accountId) throw new Error('Sign in again before renaming this session.');
  const scope = captureChatDeliveryScope(original.token, accountId);
  const session = await loadSession();
  scope.assertCurrent();
  if (!session || session.accountId !== accountId) throw new Error('Sign in again before renaming this session.');
  await defaultCloudAuthClient().updateCloudSessionTitle(session.token, sessionId, {
    title, titleSource: 'manual', titleRevision: 1, titlePolicyVersion: 1,
    titleGeneratedFromMessageId: null, updatedAtMs: Date.now(),
  });
  scope.assertCurrent();
}

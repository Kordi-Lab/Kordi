import { invokeDesktop, openOrCreateCanonicalSessionFast, removeCanonicalSessionParticipant,
  upsertCanonicalIdentityFast, upsertCanonicalMessageFast } from '@/lib/desktop';
import { browserCanonicalScope } from '@web/runtime/browserCanonicalScope';
import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { cachedSessionSnapshot } from './session';

const nativePersistence = { openOrCreateCanonicalSessionFast, removeCanonicalSessionParticipant,
  upsertCanonicalIdentityFast, upsertCanonicalMessageFast };
export type CloudGroupCanonicalPersistence = typeof nativePersistence;

/** Preserve the source scope through every await in one group replay operation. */
export function scopedCloudGroupCanonicalPersistence(accountId: string, organizationId?: string): CloudGroupCanonicalPersistence {
  const expectedBrowserScope = browserCanonicalScope(accountId, organizationId);
  return {
    openOrCreateCanonicalSessionFast: request => invokeDesktop('desktop_canonical_open_or_create_session_fast', { request, expectedBrowserScope }),
    removeCanonicalSessionParticipant: request => invokeDesktop('desktop_canonical_remove_session_participant', { request, expectedBrowserScope }),
    upsertCanonicalIdentityFast: request => invokeDesktop('desktop_canonical_upsert_identity_fast', { request, expectedBrowserScope }),
    upsertCanonicalMessageFast: request => invokeDesktop('desktop_canonical_upsert_message_fast', { request, expectedBrowserScope }),
  };
}

export function captureCloudGroupCanonicalPersistence(): CloudGroupCanonicalPersistence {
  if (!isBrowserAppRuntime()) return nativePersistence;
  const session = cachedSessionSnapshot();
  if (!session) throw new Error('Sign in to Kordi to continue.');
  return scopedCloudGroupCanonicalPersistence(session.accountId, session.organizationId);
}

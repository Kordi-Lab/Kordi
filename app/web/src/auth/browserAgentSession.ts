import { loadSession, cachedSessionSnapshot } from '@/features/cloud/session';
import { invokeDesktop } from '@/lib/desktop';
import { browserCanonicalScope } from '@web/runtime/browserCanonicalScope';
import type { CanonicalSessionCatalog, OpenCanonicalSessionFastResult } from '@/kordi-app/types';
import { ownedAgentIdentityId } from '@/features/chat/messageActions/agentMessageLifecycle';
import { rememberSessionOrganization } from '@/features/organizations/sessionOrganization';

const persistence = { load: loadSession, current: cachedSessionSnapshot, invoke: invokeDesktop, remember: rememberSessionOrganization };

/** Create the same private canonical session used by hosted Agent Chats.
 * No local process, workspace or native runtime is invented for a browser. */
export async function createBrowserAgentSession(sourceSessionId?: string, dependencies = persistence): Promise<string> {
  const session = await dependencies.load();
  if (!session) throw new Error('Sign in before creating an Agent Chat.');
  const expectedBrowserScope = browserCanonicalScope(session.accountId, session.organizationId);
  const catalog = await dependencies.invoke<CanonicalSessionCatalog>('desktop_canonical_session_catalog', { expectedBrowserScope });
  const identityId = ownedAgentIdentityId({ ...catalog, messages: [], contextSnapshots: [] }, catalog.profile.activeAgentIdentityId);
  if (!catalog.profile.humanIdentityId || !identityId) throw new Error('Your agent profile is still loading. Try again.');
  const id = `session:agent:${crypto.randomUUID()}`;
  await dependencies.invoke<OpenCanonicalSessionFastResult>('desktop_canonical_open_or_create_session_fast', {
    expectedBrowserScope,
    request: { id, kind: 'self-agent', title: 'New chat', status: 'active',
      createdByIdentityId: catalog.profile.humanIdentityId, primaryIdentityId: identityId,
      participantIdentityIds: [identityId], metadata: { source: 'ask-agent-new-chat', createdFrom: 'chat-create-flow',
        ...(sourceSessionId ? { companionSourceSessionId: sourceSessionId } : {}) } },
  });
  const current = dependencies.current();
  if (current?.accountId !== session.accountId || current?.organizationId !== session.organizationId) {
    throw new Error('The workspace changed while creating this chat.');
  }
  dependencies.remember(id);
  return id;
}

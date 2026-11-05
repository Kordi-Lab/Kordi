import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserAgentSession } from '@web/auth/browserAgentSession';
import { emptyBrowserCanonicalState, browserCanonicalCatalog } from '@web/runtime/browserCanonicalProjection';
import { applyBrowserCanonicalCommand } from '@web/runtime/browserCanonicalCommands';
import { createCanonicalSessionReadModel } from '@/features/canonical/sessionReadModel';
import { collapseBlankConversationShells } from '@/features/chat/participantSpaces';
import type { StoredSession } from '@/features/cloud/session';

test('browser Agent Chat creates an empty canonical session under the captured organization', async () => {
  const session: StoredSession = { accountId: 'synthetic-account', token: 'kordi-browser:synthetic-account', expiresAt: '', organizationId: 'synthetic-org' };
  const state = emptyBrowserCanonicalState(session.accountId);
  state.identities.push({ id: 'agent:synthetic', kind: 'agent', displayName: 'Agent', avatarKey: '',
    ownerIdentityId: state.profile.humanIdentityId, source: 'cloud', createdAtMs: 0, updatedAtMs: 0 });
  const requests: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let remembered = '';
  const dependencies = {
    load: async () => session, current: () => session,
    remember: (id: string) => { remembered = id; },
    invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      requests.push({ command, args });
      return (command === 'desktop_canonical_session_catalog' ? browserCanonicalCatalog(state) : applyBrowserCanonicalCommand(state, command, args)) as T;
    },
  };
  const id = await createBrowserAgentSession('source-session', dependencies);
  assert.equal(remembered, id);
  assert.match(id, /^session:agent:/);
  assert.equal(requests.length, 2);
  const conversations = collapseBlankConversationShells(createCanonicalSessionReadModel(state).buildChatConversations([], () => ''));
  assert.equal(conversations.find(item => item.id === id)?.name, 'New chat');
  assert.deepEqual(requests.map(item => item.args?.expectedBrowserScope), [JSON.stringify([session.accountId, session.organizationId]), JSON.stringify([session.accountId, session.organizationId])]);
  const request = requests[1].args?.request as Record<string, unknown>;
  assert.equal(request.kind, 'self-agent');
  assert.equal(request.primaryIdentityId, 'agent:synthetic');
  assert.deepEqual(request.participantIdentityIds, ['agent:synthetic']);
  assert.equal((request.metadata as Record<string, unknown>).companionSourceSessionId, 'source-session');
  assert.equal((request.metadata as Record<string, unknown>).createdFrom, 'chat-create-flow');
  assert.equal((request.metadata as Record<string, unknown>).source, 'ask-agent-new-chat');
  assert.equal(requests.some(item => item.command.startsWith('desktop_chat_')), false);
  remembered = '';
  await assert.rejects(createBrowserAgentSession(undefined, { ...dependencies,
    current: () => ({ ...session, organizationId: 'changed-org' }),
  }), /workspace changed/);
  assert.equal(remembered, '');
});

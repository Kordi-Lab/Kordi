import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatSyncConversationClient } from '@/features/cloud/chatSyncConversationClient';
import { ChatSyncState } from '@/features/cloud/chatSyncState';
import { browserSessionMarker } from '@web/auth/browserAppRuntime';
import { __setSessionBackendForTests, saveSession } from '@/features/cloud/session';
import { conversation } from '../../../desktop/tests/helpers/chatSyncCanonicalFixtures';

const accountId = 'acct_b';
const token = browserSessionMarker(accountId);
const input = { title: 'Release planning', titleSource: 'manual' as const,
  titleRevision: 1, titlePolicyVersion: 1, titleGeneratedFromMessageId: null, updatedAtMs: 1 };

test('browser title rename commits a manual hosted preference and then updates its projection', async () => {
  __setSessionBackendForTests({ load: async () => null, save: async () => {}, clear: async () => {} });
  try {
    await saveSession({ accountId, token, organizationId: 'org-original' });
    let requests = 0;
    const state = new ChatSyncState(async <T>(path: string, init: RequestInit): Promise<T> => {
      requests += 1;
      assert.equal(path, `/v2/chat/conversations/${conversation.id}/preferences`);
      assert.equal(new Headers(init.headers).get('Kordi-Organization'), 'org-original');
      assert.equal(JSON.parse(String(init.body)).personal_title, input.title);
      assert.equal(state.conversationBySessionId.get(conversation.legacy_session_id!)?.preferences.personal_title, null);
      return { preferences: { ...conversation.preferences, personal_title: input.title, version: 2 } } as T;
    }, () => accountId, () => {}, () => null);
    state.rememberConversation(conversation);
    const result = await new ChatSyncConversationClient(state).updateCloudSessionTitle(token, conversation.legacy_session_id!, input);
    assert.equal(requests, 1);
    assert.equal(result.titleSource, 'manual');
    assert.equal(state.conversationBySessionId.get(conversation.legacy_session_id!)?.preferences.personal_title, input.title);
  } finally { __setSessionBackendForTests(null); }
});

test('a workspace change during title lookup prevents the preference write', async () => {
  __setSessionBackendForTests({ load: async () => null, save: async () => {}, clear: async () => {} });
  try {
    await saveSession({ accountId, token, organizationId: 'org-original' });
    let requests = 0;
    const state = new ChatSyncState(async () => { requests += 1; throw new Error('Unexpected mutation'); }, () => accountId, () => {}, () => null);
    state.bootstrap = async () => {
      await saveSession({ accountId, token, organizationId: 'org-other' });
      state.rememberConversation(conversation);
      return { events: [], cursor: 'done' };
    };
    await assert.rejects(new ChatSyncConversationClient(state).updateCloudSessionTitle(token, conversation.legacy_session_id!, input), /organization changed/);
    assert.equal(requests, 0);
  } finally { __setSessionBackendForTests(null); }
});

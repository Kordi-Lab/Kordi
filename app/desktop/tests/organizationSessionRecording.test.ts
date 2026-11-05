import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { CloudAgentsClient } from '../src/features/cloud/cloudAgentsClient';
import type { ChatSyncConversation } from '../src/features/cloud/chatSyncTypes';
import { createScheduledTask } from '../src/features/cloud/scheduledTasksClient';
import type { CloudOrganization } from '../src/features/organizations/organizationClient';
import { setOrganizationRefreshForTests } from '../src/features/organizations/organizationForbidden';
import {
  getOrganizationState,
  organizationIdForNewContent,
  resetOrganizationAccount,
  selectOrganization,
  setAccountOrganizations,
  type OrganizationStorage,
} from '../src/features/organizations/organizationStore';
import {
  recordedSessionOrganizationId,
  rememberSessionOrganization,
  sessionOrganizationKey,
} from '../src/features/organizations/sessionOrganization';
import { conversation, message } from './helpers/chatSyncCanonicalFixtures';

const personal: CloudOrganization = {
  organizationId: 'org_personal_a', name: 'Personal', kind: 'personal', role: 'owner', memberCount: 1,
};
const team: CloudOrganization = {
  organizationId: 'org_team_example', name: 'Example team', kind: 'team', role: 'member', memberCount: 3,
};

function memoryStorage(): OrganizationStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

let localStorageValues = memoryStorage();

beforeEach(() => {
  localStorageValues = memoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorageValues });
});

afterEach(() => {
  resetOrganizationAccount(null);
  setOrganizationRefreshForTests(null);
  Reflect.deleteProperty(globalThis, 'localStorage');
});

function selectTeam(accountId = 'acct_a') {
  setAccountOrganizations(accountId, [personal, team]);
  selectOrganization(accountId, team.organizationId);
}

type CapturedBody = Record<string, unknown>;

function chatClient(created: ChatSyncConversation, statuses: number[] = []) {
  const bodies: CapturedBody[] = [];
  const client = new CloudAuthClient({ baseUrl: 'https://cloud.example.test', fetchImpl: async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v2/chat/conversations')) {
      bodies.push(JSON.parse(String(init?.body)) as CapturedBody);
      const status = statuses.shift() ?? 201;
      return status === 403
        ? new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Organization not allowed.' } }), { status })
        : new Response(JSON.stringify({ conversation: created }), { status });
    }
    if (url.endsWith('/messages')) {
      return new Response(JSON.stringify({ message: { ...message, conversation_id: created.id } }), { status: 201 });
    }
    throw new Error(`Unexpected request ${url}`);
  } });
  return { client, bodies };
}

function aiInput(sessionId: string, accountId = 'acct_a') {
  return { accountId, peerAccountId: accountId, sessionId, kind: 'ai' as const, memberAccountIds: [accountId] };
}

const aiConversation = (sessionId: string): ChatSyncConversation => ({
  ...conversation, kind: 'ai', legacy_session_id: sessionId,
});

test('the organization recorded at creation is sent even after switching', async () => {
  selectTeam();
  rememberSessionOrganization('session:group:recorded');
  assert.deepEqual([...localStorageValues.values.keys()].filter((key) => key.includes('sessions')), [
    sessionOrganizationKey('acct_a'),
  ]);
  selectOrganization('acct_a', personal.organizationId);

  const group = { ...conversation, kind: 'group' as const, legacy_session_id: 'session:group:recorded' };
  const groupClient = chatClient(group);
  await groupClient.client.sendMessage('synthetic-session', 'acct_b', 'Hello team', {
    accountId: 'acct_a', sessionId: group.legacy_session_id, conversationKind: 'group',
    memberAccountIds: ['acct_a', 'acct_b'], sharedTitle: 'Synthetic group',
  });
  assert.equal(groupClient.bodies[0]?.organization_id, team.organizationId);
  // Once the conversation exists the record is no longer needed.
  assert.equal(recordedSessionOrganizationId('acct_a', group.legacy_session_id), null);

  // Created while personal was selected, synced after switching to the team: stays personal.
  rememberSessionOrganization('session:ai:created-personal');
  selectOrganization('acct_a', team.organizationId);
  const ai = chatClient(aiConversation('session:ai:created-personal'));
  await ai.client.ensureChatConversation('synthetic-session', aiInput('session:ai:created-personal'));
  assert.equal('organization_id' in ai.bodies[0]!, false);
});

test('sessions without a recorded organization, direct chats and other accounts send nothing', async () => {
  selectTeam();
  const unrecorded = chatClient(aiConversation('session:ai:unrecorded'));
  await unrecorded.client.ensureChatConversation('synthetic-session', aiInput('session:ai:unrecorded'));
  assert.equal('organization_id' in unrecorded.bodies[0]!, false);

  rememberSessionOrganization('direct:acct_a:acct_b');
  const direct = chatClient(conversation);
  await direct.client.ensureChatConversation('synthetic-session', {
    accountId: 'acct_a', peerAccountId: 'acct_b', sessionId: 'direct:acct_a:acct_b', kind: 'direct',
  });
  assert.equal('organization_id' in direct.bodies[0]!, false);

  // A record is only made for the account whose selection is loaded, and only read for it.
  rememberSessionOrganization('session:ai:other', 'acct_c');
  assert.equal(recordedSessionOrganizationId('acct_c', 'session:ai:other'), null);
  rememberSessionOrganization('session:ai:other');
  const otherAccount = chatClient(aiConversation('session:ai:other'));
  await otherAccount.client.ensureChatConversation('synthetic-session', aiInput('session:ai:other', 'acct_c'));
  assert.equal('organization_id' in otherAccount.bodies[0]!, false);
});

test('a refused organization refreshes the list and retries once in personal when it is gone', async () => {
  selectTeam();
  rememberSessionOrganization('session:ai:left-team');
  const refreshed: string[] = [];
  setOrganizationRefreshForTests(async (accountId) => {
    refreshed.push(accountId);
    setAccountOrganizations(accountId, [personal]);
  });
  const ai = chatClient(aiConversation('session:ai:left-team'), [403]);
  await ai.client.ensureChatConversation('synthetic-session', aiInput('session:ai:left-team'));
  assert.deepEqual(refreshed, ['acct_a']);
  assert.equal(ai.bodies.length, 2);
  assert.equal(ai.bodies[0]?.organization_id, team.organizationId);
  assert.equal('organization_id' in ai.bodies[1]!, false);
  assert.equal(getOrganizationState().selectedOrganizationId, personal.organizationId);
  assert.equal(organizationIdForNewContent('acct_a'), null);
  assert.equal(recordedSessionOrganizationId('acct_a', 'session:ai:left-team'), null);
});

test('a refused organization that is still listed surfaces the error without a retry', async () => {
  selectTeam();
  rememberSessionOrganization('session:ai:still-member');
  setOrganizationRefreshForTests(async (accountId) => { setAccountOrganizations(accountId, [personal, team]); });
  const ai = chatClient(aiConversation('session:ai:still-member'), [403]);
  await assert.rejects(ai.client.ensureChatConversation('synthetic-session', aiInput('session:ai:still-member')));
  assert.equal(ai.bodies.length, 1);
  assert.equal(recordedSessionOrganizationId('acct_a', 'session:ai:still-member'), team.organizationId);

  // A failed refresh leaves an unloaded list, which never counts as having left.
  resetOrganizationAccount(null);
  resetOrganizationAccount('acct_a');
  setOrganizationRefreshForTests(async () => { throw new Error('offline'); });
  const offline = chatClient(aiConversation('session:ai:still-member'), [403]);
  await assert.rejects(offline.client.ensureChatConversation('synthetic-session', aiInput('session:ai:still-member')));
  assert.equal(offline.bodies.length, 1);
});

function agentAndTaskFetch(status: number) {
  const bodies: CapturedBody[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as CapturedBody);
    if (status === 403) {
      return new Response(JSON.stringify({ errorCode: 'organization_forbidden', message: 'Not a member.' }), { status });
    }
    return String(input).includes('scheduled-tasks')
      ? new Response(JSON.stringify({ task: { taskId: 'task_1' } }), { status: 201 })
      : new Response(JSON.stringify({ agent: null }), { status: 201 });
  };
  return { bodies, fetchImpl: fetchImpl as typeof fetch };
}

const agentInput = { name: 'Helper', role: 'Assistant', systemPrompt: 'Be brief.' };
const taskInput = {
  title: 'Daily note', prompt: 'Summarize.', schedule: { kind: 'once' as const, at: '2026-12-01T00:00:00Z' },
  targetRuntime: 'cloud' as const,
};

test('Agent and task bodies omit organizationId unless the selection belongs to the signed-in account', async () => {
  selectTeam('acct_a');
  const { bodies, fetchImpl } = agentAndTaskFetch(201);
  const agents = new CloudAgentsClient({ baseUrl: 'https://cloud.example.test', fetchImpl });
  const config = { apiBase: 'https://cloud.example.test', token: 'synthetic-session', fetcher: fetchImpl };

  await assert.rejects(agents.createCloudAgent('synthetic-session', agentInput, 'acct_b'));
  await assert.rejects(agents.createCloudAgent('synthetic-session', agentInput));
  await createScheduledTask({ ...config, accountId: 'acct_b' }, taskInput);
  await createScheduledTask(config, taskInput);
  assert.deepEqual(bodies.map((body) => 'organizationId' in body), [false, false, false, false]);

  await createScheduledTask({ ...config, accountId: 'acct_a' }, taskInput);
  assert.equal(bodies[4]?.organizationId, team.organizationId);
});

test('a refused Agent or task organization refreshes the list and falls back to personal', async () => {
  const refreshed: string[] = [];
  setOrganizationRefreshForTests(async (accountId) => {
    refreshed.push(accountId);
    setAccountOrganizations(accountId, [personal]);
  });
  const { bodies, fetchImpl } = agentAndTaskFetch(403);
  const agents = new CloudAgentsClient({ baseUrl: 'https://cloud.example.test', fetchImpl });

  selectTeam();
  await assert.rejects(agents.createCloudAgent('synthetic-session', agentInput, 'acct_a'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bodies[0]?.organizationId, team.organizationId);
  assert.deepEqual(refreshed, ['acct_a']);
  assert.equal(organizationIdForNewContent('acct_a'), null);

  selectTeam();
  await assert.rejects(createScheduledTask({
    apiBase: 'https://cloud.example.test', token: 'synthetic-session', accountId: 'acct_a', fetcher: fetchImpl,
  }, taskInput));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bodies[1]?.organizationId, team.organizationId);
  assert.deepEqual(refreshed, ['acct_a', 'acct_a']);
  assert.equal(getOrganizationState().selectedOrganizationId, personal.organizationId);
});

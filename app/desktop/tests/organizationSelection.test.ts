import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { CloudAgentsClient } from '../src/features/cloud/cloudAgentsClient';
import type { ChatSyncConversation } from '../src/features/cloud/chatSyncTypes';
import { createScheduledTask } from '../src/features/cloud/scheduledTasksClient';
import {
  groupOrganizationName,
  groupOrganizationNames,
} from '../src/features/organizations/conversationOrganization';
import {
  fetchCloudOrganizations,
  normalizeCloudOrganizations,
  type CloudOrganization,
} from '../src/features/organizations/organizationClient';
import {
  getOrganizationState,
  organizationIdForNewContent,
  organizationSelectionKey,
  readStoredOrganizationId,
  resetOrganizationAccount,
  resolveSelectedOrganizationId,
  selectOrganization,
  setAccountOrganizations,
  type OrganizationStorage,
} from '../src/features/organizations/organizationStore';
import {
  refreshOrganizations,
  resetOrganizationRefreshForTests,
} from '../src/features/organizations/useOrganizations';
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

afterEach(() => {
  resetOrganizationAccount(null);
  resetOrganizationRefreshForTests();
});

test('organization list keeps valid entries with the personal organization first', () => {
  const organizations = normalizeCloudOrganizations({
    organizations: [
      { organizationId: 'org_team_example', name: 'Example team', kind: 'team', role: 'admin', memberCount: 4 },
      { organizationId: 'org_personal_a', name: 'Personal', kind: 'personal', role: 'owner', memberCount: 1 },
      { organizationId: 'org_team_example', name: 'Duplicate', kind: 'team', role: 'member' },
      { organizationId: '', name: 'Missing id', kind: 'team' },
      { organizationId: 'org_other', name: 'Unknown kind', kind: 'school' },
    ],
  });
  assert.deepEqual(organizations.map((item) => [item.organizationId, item.kind, item.role]), [
    ['org_personal_a', 'personal', 'owner'],
    ['org_team_example', 'team', 'admin'],
  ]);
  assert.deepEqual(normalizeCloudOrganizations(null), []);
});

test('organization fetch uses the cloud session token', async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const organizations = await fetchCloudOrganizations('synthetic-session', {
    baseUrl: 'https://cloud.example.test',
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ organizations: [personal, team] }), { status: 200 });
    },
  });
  assert.deepEqual(requests, [{
    url: 'https://cloud.example.test/v1/cloud/organizations',
    authorization: 'Bearer synthetic-session',
  }]);
  assert.deepEqual(organizations.map((item) => item.name), ['Personal', 'Example team']);
});

test('selection falls back to the personal organization when the stored one is gone', () => {
  assert.equal(resolveSelectedOrganizationId([personal, team], team.organizationId), team.organizationId);
  assert.equal(resolveSelectedOrganizationId([personal, team], 'org_left_team'), personal.organizationId);
  assert.equal(resolveSelectedOrganizationId([personal, team], null), personal.organizationId);
  assert.equal(resolveSelectedOrganizationId([], 'org_left_team'), null);

  const storage = memoryStorage();
  storage.setItem(organizationSelectionKey('acct_a'), 'org_left_team');
  setAccountOrganizations('acct_a', [personal, team], storage);
  assert.equal(getOrganizationState().selectedOrganizationId, personal.organizationId);
  assert.equal(organizationIdForNewContent('acct_a'), null);
});

test('selection is stored per account under its own key only', () => {
  const storage = memoryStorage();
  setAccountOrganizations('acct_a', [personal, team], storage);
  selectOrganization('acct_a', team.organizationId, storage);
  assert.deepEqual([...storage.values.keys()], ['kordi.organization.selected.acct_a']);
  assert.equal(readStoredOrganizationId('acct_a', storage), team.organizationId);
  assert.equal(readStoredOrganizationId('acct_b', storage), null);
  assert.equal(organizationIdForNewContent('acct_a'), team.organizationId);
  assert.equal(organizationIdForNewContent('acct_b'), null);

  setAccountOrganizations('acct_b', [{ ...personal, organizationId: 'org_personal_b' }, team], storage);
  assert.equal(getOrganizationState().selectedOrganizationId, 'org_personal_b');
  // Selecting for an account that is not current, or an organization outside the list, is ignored.
  selectOrganization('acct_a', personal.organizationId, storage);
  selectOrganization('acct_b', 'org_not_a_member', storage);
  assert.equal(readStoredOrganizationId('acct_a', storage), team.organizationId);
  assert.equal(readStoredOrganizationId('acct_b', storage), null);
});

test('storage failures leave the personal organization selected', () => {
  const throwing: OrganizationStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  setAccountOrganizations('acct_a', [personal, team], throwing);
  assert.equal(getOrganizationState().selectedOrganizationId, personal.organizationId);
  selectOrganization('acct_a', team.organizationId, throwing);
  assert.equal(organizationIdForNewContent('acct_a'), team.organizationId);
});

test('refresh failures are silent and keep the personal organization', async () => {
  resetOrganizationAccount('acct_a');
  await refreshOrganizations('acct_a', {
    force: true,
    deps: {
      loadSession: async () => ({ token: 'synthetic-session', accountId: 'acct_a', expiresAt: '2027-01-01T00:00:00Z' }),
      fetchOrganizations: async () => { throw new Error('offline'); },
      now: () => 0,
    },
  });
  assert.deepEqual(getOrganizationState().organizations, []);
  assert.equal(organizationIdForNewContent('acct_a'), null);

  // A session for a different account never fills this account's list.
  await refreshOrganizations('acct_a', {
    force: true,
    deps: {
      loadSession: async () => ({ token: 'synthetic-session', accountId: 'acct_b', expiresAt: '2027-01-01T00:00:00Z' }),
      fetchOrganizations: async () => [personal, team],
      now: () => 0,
    },
  });
  assert.deepEqual(getOrganizationState().organizations, []);
});

function capturingChatClient(created: ChatSyncConversation) {
  const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = new CloudAuthClient({ baseUrl: 'https://cloud.example.test', fetchImpl: async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v2/chat/conversations')) {
      bodies.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ conversation: created }), { status: 201 });
    }
    if (url.endsWith('/messages')) {
      return new Response(JSON.stringify({ message: { ...message, conversation_id: created.id } }), { status: 201 });
    }
    throw new Error(`Unexpected request ${url}`);
  } });
  return { client, bodies };
}

function selectTeam(accountId = 'acct_a') {
  const storage = memoryStorage();
  setAccountOrganizations(accountId, [personal, team], storage);
  selectOrganization(accountId, team.organizationId, storage);
}

test('new group and AI conversations carry the selected team organization', async () => {
  selectTeam();
  const group = { ...conversation, kind: 'group' as const, legacy_session_id: 'session:group:org-new' };
  const groupClient = capturingChatClient(group);
  await groupClient.client.sendMessage('synthetic-session', 'acct_b', 'Hello team', {
    accountId: 'acct_a', sessionId: group.legacy_session_id, conversationKind: 'group',
    memberAccountIds: ['acct_a', 'acct_b'], sharedTitle: 'Synthetic group',
  });
  assert.equal(groupClient.bodies[0]?.body.organization_id, team.organizationId);

  const ai = { ...conversation, kind: 'ai' as const, legacy_session_id: 'session:ai:org-new' };
  const aiClient = capturingChatClient(ai);
  await aiClient.client.ensureChatConversation('synthetic-session', {
    accountId: 'acct_a', peerAccountId: 'acct_a', sessionId: ai.legacy_session_id, kind: 'ai', memberAccountIds: ['acct_a'],
  });
  assert.equal(aiClient.bodies[0]?.body.organization_id, team.organizationId);
});

test('direct chats, the personal organization and other accounts omit organization_id', async () => {
  selectTeam();
  const direct = capturingChatClient(conversation);
  await direct.client.ensureChatConversation('synthetic-session', {
    accountId: 'acct_a', peerAccountId: 'acct_b', kind: 'direct',
  });
  assert.equal('organization_id' in (direct.bodies[0]?.body ?? {}), false);

  const ai = { ...conversation, kind: 'ai' as const, legacy_session_id: 'session:ai:other-account' };
  const otherAccount = capturingChatClient(ai);
  await otherAccount.client.ensureChatConversation('synthetic-session', {
    accountId: 'acct_c', peerAccountId: 'acct_c', sessionId: ai.legacy_session_id, kind: 'ai', memberAccountIds: ['acct_c'],
  });
  assert.equal('organization_id' in (otherAccount.bodies[0]?.body ?? {}), false);

  const recovered = capturingChatClient({ ...ai, legacy_session_id: 'session:ai:recovered' });
  await recovered.client.ensureChatConversation('synthetic-session', {
    accountId: 'acct_a', peerAccountId: 'acct_a', sessionId: 'session:ai:recovered', kind: 'ai',
    memberAccountIds: ['acct_a'], personalOrganization: true,
  });
  assert.equal('organization_id' in (recovered.bodies[0]?.body ?? {}), false);

  selectOrganization('acct_a', personal.organizationId, memoryStorage());
  const personalAi = capturingChatClient({ ...ai, legacy_session_id: 'session:ai:personal' });
  await personalAi.client.ensureChatConversation('synthetic-session', {
    accountId: 'acct_a', peerAccountId: 'acct_a', sessionId: 'session:ai:personal', kind: 'ai', memberAccountIds: ['acct_a'],
  });
  assert.equal('organization_id' in (personalAi.bodies[0]?.body ?? {}), false);
});

test('new Agents and scheduled tasks carry organizationId only for a team selection', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const url = String(input);
    return url.includes('scheduled-tasks')
      ? new Response(JSON.stringify({ task: { taskId: 'task_1' } }), { status: 201 })
      : new Response(JSON.stringify({ agent: null }), { status: 201 });
  };
  const agents = new CloudAgentsClient({ baseUrl: 'https://cloud.example.test', fetchImpl });
  const input = { name: 'Helper', role: 'Assistant', systemPrompt: 'Be brief.' };
  const task = {
    title: 'Daily note', prompt: 'Summarize.', schedule: { kind: 'once' as const, at: '2026-12-01T00:00:00Z' },
    targetRuntime: 'cloud' as const,
  };
  const config = { apiBase: 'https://cloud.example.test', token: 'synthetic-session', fetcher: fetchImpl as typeof fetch };

  await assert.rejects(agents.createCloudAgent('synthetic-session', input));
  await createScheduledTask(config, task);
  assert.equal('organizationId' in bodies[0]!, false);
  assert.equal('organizationId' in bodies[1]!, false);

  selectTeam();
  await assert.rejects(agents.createCloudAgent('synthetic-session', input));
  await createScheduledTask(config, task);
  assert.equal(bodies[2]?.organizationId, team.organizationId);
  assert.equal(bodies[3]?.organizationId, team.organizationId);
});

test('group snapshots keep their team organization; personal and non-group snapshots have none', () => {
  const teamGroup: ChatSyncConversation = {
    ...conversation,
    id: 'conv_team_group',
    kind: 'group',
    legacy_session_id: 'session:group:team',
    organization: { organization_id: team.organizationId, name: 'Example team' },
  };
  const personalGroup: ChatSyncConversation = {
    ...conversation, id: 'conv_personal_group', kind: 'group', legacy_session_id: 'session:group:personal',
  };
  const teamAi: ChatSyncConversation = {
    ...conversation, id: 'conv_team_ai', kind: 'ai', organization: teamGroup.organization,
  };
  assert.equal(groupOrganizationName(teamGroup), 'Example team');
  assert.equal(groupOrganizationName(personalGroup), null);
  assert.equal(groupOrganizationName({ ...personalGroup, organization: null }), null);
  assert.equal(groupOrganizationName(teamAi), null);
  const names = groupOrganizationNames([teamGroup, personalGroup, teamAi]);
  assert.deepEqual([...names.entries()], [
    ['conv_team_group', 'Example team'],
    ['session:group:team', 'Example team'],
  ]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import type { ChatSyncConversation } from '../src/features/cloud/chatSyncTypes';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/cloudSelfAgentCanonicalSync';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { markerlessSnapshotSessionIds } from '../src/features/personalAgent/personalAgentClient';
import { planPersonalAgentMarkerRemovals, type PersonalAgentSessionPlan } from '../src/features/personalAgent/personalAgentSessions';
import {
  getPersonalAgentEntries,
  isPersonalAgentListLoaded,
  requestPersonalAgentsRefresh,
  setPersonalAgentEntries,
  subscribePersonalAgentsRefresh,
} from '../src/features/personalAgent/personalAgentStore';
import { usePersonalAgentSync } from '../src/features/personalAgent/usePersonalAgentSync';
import { factoryProactiveControl, useCreationProactiveDraft, useDefaultAgentProactive } from '../src/kordi-app/agents/factoryProactiveDraft';
import type { Agent, CanonicalSessionState } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const ACCOUNT = 'acct_alex';
const DEFAULT_ID = `cloud-agent:${ACCOUNT}`;
const KORDI_SESSION = `session:self-agent:${ACCOUNT}:personal:${DEFAULT_ID}`;
const RESEARCH_SESSION = `session:self-agent:${ACCOUNT}:personal:cloud_agent_research`;
const kordi = { id: 'desktop:local-agent', name: "Alex's Kordi", role: 'Assistant', isOwned: true, systemPrompt: '', loadedTools: [], loadedSkills: [], loadedPlugins: [], contactId: 'desktop:local-agent', messaging: 'Local', status: 'Ready', tasks: 0, defaultProvider: '', defaultModel: '', collaborationConfig: '', xMd: '', identityFiles: [], lastActivities: [] } as unknown as Agent;
const research = { ...kordi, id: 'cloud-agent:cloud_agent_research', name: 'Research agent', cloudAgentId: 'cloud_agent_research', contactId: 'cloud-agent:cloud_agent_research', cloudAgentPersonalAgent: { proactive: false } } as Agent;

function session(id: string, metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id, kind: 'direct-agent', title: 'Research agent', status: 'active', createdByIdentityId: 'human:alex', primaryIdentityId: 'agent:cloud-agent-research', projectId: null, projectName: null, relationshipIdentityId: null, metadata, ...extra };
}

function state(sessions: unknown[]): CanonicalSessionState {
  return {
    profile: { humanIdentityId: 'human:alex', activeAgentIdentityId: 'agent:local' },
    identities: [
      { id: 'human:alex', kind: 'human', displayName: 'Alex' },
      { id: 'agent:local', kind: 'agent', displayName: "Alex's Kordi", ownerIdentityId: 'human:alex' },
      { id: 'agent:cloud-owned:cloud_agent_other', kind: 'agent', agentId: 'cloud_agent_other', displayName: 'Other agent', ownerIdentityId: 'human:alex' },
    ],
    sessions, participants: [], messages: [], contextSnapshots: [],
  } as unknown as CanonicalSessionState;
}

const researchMarked = session(RESEARCH_SESSION, { createdFrom: 'chat-create-flow', cloudAgentId: 'cloud_agent_research', personalAgent: { agentId: 'cloud_agent_research' }, sessionTitleSource: 'manual' });
const kordiMarked = session(KORDI_SESSION, { cloudSelfAgentSession: true, personalAgent: { agentId: DEFAULT_ID } }, { kind: 'self-agent', primaryIdentityId: 'agent:local', title: "Alex's Kordi" });

test('an agent that left the list loses its personal marker; nothing is stripped without a loaded source', () => {
  const current = state([researchMarked, kordiMarked]);
  // The loaded list holds only the default agent: Research agent's Proactive is off.
  const removals = planPersonalAgentMarkerRemovals(current, { listedSessionIds: new Set([KORDI_SESSION]), markerlessSnapshotSessionIds: new Set() });
  assert.deepEqual(removals.map((plan) => plan.session.id), [RESEARCH_SESSION]);
  const stripped = removals[0]!.session;
  assert.equal((stripped.metadata as Record<string, unknown>).personalAgent, null);
  assert.equal((stripped.metadata as Record<string, unknown>).sessionTitleSource, 'manual');
  assert.equal(stripped.kind, 'direct-agent');
  assert.equal(stripped.primaryIdentityId, 'agent:cloud-agent-research');
  // Before the list loads, only a session whose own snapshot lost the marker is stripped.
  assert.deepEqual(planPersonalAgentMarkerRemovals(current, { listedSessionIds: null, markerlessSnapshotSessionIds: new Set([RESEARCH_SESSION]) }).map((plan) => plan.session.id), [RESEARCH_SESSION]);
  assert.deepEqual(planPersonalAgentMarkerRemovals(current, { listedSessionIds: null, markerlessSnapshotSessionIds: new Set() }), []);
  // A stripped session is left alone afterwards.
  assert.deepEqual(planPersonalAgentMarkerRemovals(state([{ ...researchMarked, metadata: { personalAgent: null } }]), { listedSessionIds: new Set(), markerlessSnapshotSessionIds: new Set() }), []);
  assert.deepEqual([...markerlessSnapshotSessionIds([
    { id: 'c1', kind: 'ai', legacy_session_id: RESEARCH_SESSION, personal_agent: null },
    { id: 'c2', kind: 'ai', legacy_session_id: KORDI_SESSION, personal_agent: { agent_id: DEFAULT_ID } },
    { id: 'c3', kind: 'group', legacy_session_id: 'session:group:x' },
  ] as unknown as ChatSyncConversation[])], [RESEARCH_SESSION]);
});

function mention(sessionId: string): CloudMessage {
  return {
    messageId: `mention-${sessionId}`, sessionId, fromAccountId: ACCOUNT, toAccountId: ACCOUNT,
    createdAt: '2026-10-25T10:00:00Z', direction: 'outgoing', deliveredAt: null, readAt: null,
    body: encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: '@Other agent look',
      targetCloudAgentId: 'cloud_agent_other', targetCloudAgentName: 'Other agent', targetCloudAgentOwnerAccountId: ACCOUNT }),
  };
}

test('once its agent leaves the list, the old session is no longer guarded as personal', () => {
  const account = { accountId: ACCOUNT, displayName: 'Alex' } as CloudAccount;
  // Before any list: the marker guards the session.
  setPersonalAgentEntries([], false);
  const guarded = planCloudSelfAgentCanonicalSync({ account, state: state([researchMarked]), messages: [mention(RESEARCH_SESSION)] });
  assert.equal(guarded.sessionRequests.some((request) => request.primaryIdentityId === 'agent:cloud-owned:cloud_agent_other'), false);
  // The loaded list no longer has Research agent: the session is an ordinary chat again.
  setPersonalAgentEntries([{ agentId: DEFAULT_ID, conversationId: 'conv', sessionId: KORDI_SESSION, proactive: true, name: "Alex's Kordi", localAgentId: kordi.id, avatarSeed: 'seed', profileImageUrl: null, isDefault: true }], true);
  try {
    assert.equal(isPersonalAgentListLoaded(), true);
    const ordinary = planCloudSelfAgentCanonicalSync({ account, state: state([researchMarked]), messages: [mention(RESEARCH_SESSION)] });
    assert.equal(ordinary.sessionRequests.find((request) => request.id === RESEARCH_SESSION)?.primaryIdentityId, 'agent:cloud-owned:cloud_agent_other');
  } finally {
    setPersonalAgentEntries([], false);
  }
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean, timeoutMs = 5_000) {
  for (let waited = 0; !ready(); waited += 5) {
    if (waited >= timeoutMs) return;
    await wait(5);
  }
}

test('the sync strips sessions that left the list, keeps them when the list fails, and reloads on demand', async () => {
  __setSessionBackendForTests({ load: async () => ({ token: 'token', accountId: ACCOUNT, expiresAt: '2099-01-01T00:00:00Z' }), save: async () => undefined, clear: async () => undefined });
  let fail = true;
  let calls = 0;
  const plans: PersonalAgentSessionPlan[] = [];
  const current = state([researchMarked, kordiMarked]);
  function Harness({ agents }: { agents: Agent[] }) {
    usePersonalAgentSync({
      accountId: ACCOUNT, agents, canonicalState: current, setCanonicalState: () => undefined, canCreateSessions: true,
      retryDelaysMs: [60_000], loadCachedConversations: async () => [],
      list: async () => {
        calls += 1;
        if (fail) throw new Error('503');
        return [{ agentId: DEFAULT_ID, conversationId: 'conv', sessionId: KORDI_SESSION, proactive: true }];
      },
      createSession: async (plan) => { plans.push(plan); return (value) => value; },
    });
    return null;
  }
  try {
    await withJsdomRoot(async (mount) => {
      const agents = [kordi, research];
      await mount(createElement(Harness, { agents }));
      await act(async () => { await until(() => calls >= 1); await wait(10); });
      assert.equal(calls, 1);
      // The list failed and no snapshot names anything: nothing is stripped.
      assert.equal(plans.filter((plan) => (plan.session.metadata as Record<string, unknown>).personalAgent === null).length, 0);

      // Proactive changed in the Blueprint: the list loads again at once.
      fail = false;
      await act(async () => { requestPersonalAgentsRefresh(); await until(() => plans.some((plan) => (plan.session.metadata as Record<string, unknown>).personalAgent === null)); });
      assert.equal(calls, 2);
      assert.deepEqual(getPersonalAgentEntries().map((entry) => entry.agentId), [DEFAULT_ID]);
      assert.deepEqual(plans.filter((plan) => (plan.session.metadata as Record<string, unknown>).personalAgent === null).map((plan) => plan.session.id), [RESEARCH_SESSION]);

      // A Factory agent's Proactive change reaches the agent list and reloads too.
      await mount(createElement(Harness, { agents: [kordi, { ...research, cloudAgentPersonalAgent: { proactive: true } }] }));
      await act(async () => { await until(() => calls >= 3); });
      assert.equal(calls, 3);
    });
  } finally {
    __setSessionBackendForTests(null);
    setPersonalAgentEntries([], false);
  }
});

test('the default agent shows the server Proactive value, a new agent starts off, and a change refreshes the list', async () => {
  __setSessionBackendForTests({ load: async () => ({ token: 'token', accountId: ACCOUNT, expiresAt: '2099-01-01T00:00:00Z' }), save: async () => undefined, clear: async () => undefined });
  const previous = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (init.body) bodies.push(JSON.parse(String(init.body)));
    // The server's effective value: the default agent is on unless turned off.
    if (String(url).includes('/personal-agent')) return new Response(JSON.stringify({ proactive: init.method === 'PUT' ? (JSON.parse(String(init.body)) as { proactive: boolean }).proactive : true }), { status: 200 });
    return new Response(JSON.stringify({ enabled: false }), { status: 200 });
  }) as typeof fetch;
  let refreshes = 0;
  const unsubscribe = subscribePersonalAgentsRefresh(() => { refreshes += 1; });
  let settings: ReturnType<typeof useDefaultAgentProactive> | null = null;
  let creation: ReturnType<typeof useCreationProactiveDraft> | null = null;
  function Harness() {
    settings = useDefaultAgentProactive(kordi, ACCOUNT);
    creation = useCreationProactiveDraft('draft-new-agent');
    return null;
  }
  try {
    await withJsdomRoot(async (mount) => {
      await mount(createElement(Harness));
      await act(async () => { await until(() => settings?.personalPublished !== null); });
      assert.equal(settings!.personalPublished, true);
      const control = factoryProactiveControl({
        creating: false, creation: creation!, agent: kordi, config: { systemPrompt: '', loadedSkills: [], loadedTools: [], loadedPlugins: [] },
        setProactiveDraft: () => undefined, setPersonalProactiveDraft: () => undefined, defaultAgent: settings!,
      });
      assert.equal(control?.personal?.enabled, true);
      // A new Factory agent's Proactive starts off and sends nothing.
      assert.equal(creation!.personalEnabled, false);
      assert.equal(creation!.personalInput, undefined);
      const created = factoryProactiveControl({ creating: true, creation: creation!, config: null, setProactiveDraft: () => undefined });
      assert.equal(created?.personal?.enabled, false);

      await act(async () => { await settings!.publishPersonal(false); });
      assert.deepEqual(bodies.at(-1), { proactive: false });
      assert.equal(settings!.personalPublished, false);
      assert.equal(refreshes, 1);
    });
  } finally {
    unsubscribe();
    globalThis.fetch = previous;
    __setSessionBackendForTests(null);
  }
});

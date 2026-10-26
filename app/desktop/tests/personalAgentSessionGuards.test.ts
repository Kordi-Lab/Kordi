import assert from 'node:assert/strict';
import test from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/cloudSelfAgentCanonicalSync';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { joinPersonalAgents } from '../src/features/personalAgent/personalAgentEntries';
import { planPersonalAgentSessions } from '../src/features/personalAgent/personalAgentSessions';
import { setPersonalAgentEntries } from '../src/features/personalAgent/personalAgentStore';
import { canChooseChatProject } from '../src/features/projects/chatProjects';
import type { Agent, CanonicalSessionState, Conversation } from '../src/kordi-app/types';

const ACCOUNT = 'acct_alex';
const DEFAULT_ID = `cloud-agent:${ACCOUNT}`;
const DEFAULT_SESSION = `session:self-agent:${ACCOUNT}:personal:${DEFAULT_ID}`;
const RESEARCH_SESSION = `session:self-agent:${ACCOUNT}:personal:cloud_agent_research`;
const account = { accountId: ACCOUNT, displayName: 'Alex' } as CloudAccount;

const kordi = { id: 'desktop:local-agent', name: "Alex's Kordi", role: 'Assistant', isOwned: true, systemPrompt: '', loadedTools: [], loadedSkills: [], loadedPlugins: [], contactId: 'desktop:local-agent' } as unknown as Agent;
const research = { id: 'cloud-agent:cloud_agent_research', name: 'Research agent', role: 'Research', isOwned: true, cloudAgentId: 'cloud_agent_research', systemPrompt: 'Read.', loadedTools: [], loadedSkills: [], loadedPlugins: [], contactId: 'cloud-agent:cloud_agent_research' } as unknown as Agent;
const entries = joinPersonalAgents([
  { agentId: DEFAULT_ID, conversationId: 'conv-kordi', sessionId: DEFAULT_SESSION, proactive: true },
  { agentId: 'cloud_agent_research', conversationId: 'conv-research', sessionId: RESEARCH_SESSION, proactive: true },
], [kordi, research], ACCOUNT);

function state(sessions: unknown[] = []): CanonicalSessionState {
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

function mention(sessionId: string): CloudMessage {
  return {
    messageId: `mention-${sessionId}`, sessionId, fromAccountId: ACCOUNT, toAccountId: ACCOUNT,
    createdAt: '2026-10-25T10:00:00Z', direction: 'outgoing', deliveredAt: null, readAt: null,
    body: encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: '@Other agent can you check this?',
      targetCloudAgentId: 'cloud_agent_other', targetCloudAgentName: 'Other agent', targetCloudAgentOwnerAccountId: ACCOUNT }),
  };
}

test('an @mention in a personal session never turns it into another agent\'s chat', () => {
  const personal = { id: RESEARCH_SESSION, kind: 'direct-agent', title: 'Research agent', status: 'active', primaryIdentityId: 'agent:cloud-agent-cloud_agent_research',
    metadata: { createdFrom: 'chat-create-flow', cloudAgentId: 'cloud_agent_research', personalAgent: { agentId: 'cloud_agent_research' } } };
  const ordinary = { id: 'session:direct-agent:ordinary', kind: 'self-agent', title: 'Chat', status: 'active', primaryIdentityId: 'agent:local', metadata: {} };
  const plan = planCloudSelfAgentCanonicalSync({ account, state: state([personal, ordinary]), messages: [mention(RESEARCH_SESSION), mention(ordinary.id)] });
  assert.equal(plan.sessionRequests.find((request) => request.id === RESEARCH_SESSION)?.primaryIdentityId === 'agent:cloud-owned:cloud_agent_other', false);
  assert.equal(plan.sessionRequests.find((request) => request.id === ordinary.id)?.primaryIdentityId, 'agent:cloud-owned:cloud_agent_other');

  // Known only from the server list (no marker yet), the session is protected as well.
  setPersonalAgentEntries(entries);
  try {
    const unmarked = { ...personal, metadata: { createdFrom: 'chat-create-flow', cloudAgentId: 'cloud_agent_research' } };
    const listed = planCloudSelfAgentCanonicalSync({ account, state: state([unmarked]), messages: [mention(RESEARCH_SESSION)] });
    assert.equal(listed.sessionRequests.some((request) => request.primaryIdentityId === 'agent:cloud-owned:cloud_agent_other'), false);
  } finally {
    setPersonalAgentEntries([]);
  }
});

test('the planner repairs a personal session rewritten for another agent and leaves a correct one alone', () => {
  const rewritten = [
    { id: RESEARCH_SESSION, kind: 'direct-agent', title: 'Research agent', status: 'active', primaryIdentityId: 'agent:cloud-owned:cloud_agent_other',
      metadata: { cloudSelfAgentTarget: true, cloudAgentId: 'cloud_agent_other', cloudAgentName: 'Other agent', personalAgent: { agentId: 'cloud_agent_research' } } },
    { id: DEFAULT_SESSION, kind: 'direct-agent', title: "Alex's Kordi", status: 'active', primaryIdentityId: 'agent:cloud-owned:cloud_agent_other',
      metadata: { cloudSelfAgentSession: true, cloudSelfAgentTarget: true, cloudAgentId: 'cloud_agent_other', personalAgent: { agentId: DEFAULT_ID } } },
  ];
  const plans = planPersonalAgentSessions(entries, [kordi, research], state(rewritten));
  const own = plans.find((plan) => plan.session.id === DEFAULT_SESSION)!;
  assert.equal(own.session.kind, 'self-agent');
  assert.equal(own.session.primaryIdentityId, 'agent:local');
  assert.equal((own.session.metadata as Record<string, unknown>).cloudAgentId, undefined);
  assert.equal((own.session.metadata as Record<string, unknown>).cloudSelfAgentTarget, undefined);
  const factory = plans.find((plan) => plan.session.id === RESEARCH_SESSION)!;
  assert.equal(factory.session.kind, 'direct-agent');
  assert.equal(factory.session.primaryIdentityId, factory.identity?.id);
  assert.equal((factory.session.metadata as Record<string, unknown>).cloudAgentId, 'cloud_agent_research');

  // Applied, the sessions are correct and nothing more is planned. The mirror's own identity also counts for the default agent.
  const repaired = plans.map((plan) => ({ ...plan.session, id: plan.session.id! }));
  assert.deepEqual(planPersonalAgentSessions(entries, [kordi, research], state(repaired)), []);
  const mirrored = repaired.map((session) => session.id === DEFAULT_SESSION ? { ...session, primaryIdentityId: `agent:cloud-self:${ACCOUNT}` } : session);
  assert.deepEqual(planPersonalAgentSessions(entries, [kordi, research], state(mirrored)), []);
});

test('a personal session can never be moved into a project', () => {
  const chat = (overrides: Partial<Conversation>) => ({
    id: 'session:self-agent:x', canonicalSessionId: 'session:self-agent:x', name: 'Chat', type: 'owned-agent', subtitle: '', unread: 0,
    collaborationSources: [], trust: 'Owned', directness: 'Agent chat', participants: [], messages: [], desktopRuntimeBacked: true,
    ...overrides,
  }) as Conversation;
  assert.equal(canChooseChatProject(chat({})), true);
  assert.equal(canChooseChatProject(chat({ metadata: { personalAgent: { agentId: DEFAULT_ID } } })), false);
  setPersonalAgentEntries(entries);
  try {
    assert.equal(canChooseChatProject(chat({ id: RESEARCH_SESSION, canonicalSessionId: RESEARCH_SESSION })), false);
  } finally {
    setPersonalAgentEntries([]);
  }
});

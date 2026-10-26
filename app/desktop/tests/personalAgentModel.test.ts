import assert from 'node:assert/strict';
import { test } from 'node:test';

import { existingBlankSessionIdForAgentStart } from '../src/features/chat/chatCreateFlows';
import { collapseBlankConversationShells } from '../src/features/chat/participantSpaces';
import { normalizePersonalAgentSessions } from '../src/features/personalAgent/personalAgentClient';
import {
  isPersonalAgentConversation,
  joinPersonalAgents,
  personalAgentEntryForConversation,
  personalAgentMarker,
} from '../src/features/personalAgent/personalAgentEntries';
import { planPersonalAgentSessions } from '../src/features/personalAgent/personalAgentSessions';
import { personalAgentIdFromRowKey, personalAgentSidebarRows } from '../src/features/personalAgent/personalAgentSidebarRows';
import { getPersonalAgentEntries, setPersonalAgentEntries, subscribePersonalAgentEntries, type PersonalAgentEntry } from '../src/features/personalAgent/personalAgentStore';
import { pendingAgentBlueprintRequest, requestAgentBlueprint } from '../src/features/personalAgent/agentBlueprintRequest';
import { projectChatGroups } from '../src/features/projects/projectChatGroups';
import type { Agent, CanonicalSessionState, Conversation } from '../src/kordi-app/types';
import type { ChatSidebarRow } from '../src/pages/sidebar/chatSidebarRows';

const ACCOUNT = 'acct_alex';
const DEFAULT_ID = `cloud-agent:${ACCOUNT}`;
const DEFAULT_SESSION = `session:self-agent:${ACCOUNT}:personal:${DEFAULT_ID}`;
const RESEARCH_SESSION = `session:self-agent:${ACCOUNT}:personal:cloud_agent_research`;

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: 'desktop:local-agent', name: "Alex's Kordi", role: 'Assistant', messaging: 'Local', status: 'Ready', tasks: 0,
    defaultProvider: 'OpenAI', defaultModel: 'gpt-test', collaborationConfig: 'Local', contactId: 'desktop:local-agent',
    systemPrompt: 'Help.', xMd: '', identityFiles: [], loadedTools: [], loadedSkills: [], loadedPlugins: [], lastActivities: [], isOwned: true,
    ...overrides,
  };
}

const kordi = agent({});
const research = agent({
  id: 'cloud-agent:cloud_agent_research', name: 'Research agent', contactId: 'cloud-agent:cloud_agent_research',
  cloudAgentId: 'cloud_agent_research', avatarSeed: 'owl-seed', profileImageUrl: 'https://avatars.test/owl.png',
});

const sessions = normalizePersonalAgentSessions({ agents: [
  { agentId: DEFAULT_ID, conversationId: 'conv-kordi', sessionId: DEFAULT_SESSION, proactive: true },
  { agentId: 'cloud_agent_research', conversationId: 'conv-research', sessionId: RESEARCH_SESSION, proactive: false },
  { agentId: 'cloud_agent_unknown', conversationId: 'conv-unknown', sessionId: 'session:unknown' },
  { agentId: DEFAULT_ID, conversationId: 'conv-dup', sessionId: 'session:dup' },
  { agentId: '', sessionId: 'session:none' },
  'not an entry',
] });

test('the personal agents list keeps one entry per agent in server order', () => {
  assert.deepEqual(sessions.map((entry) => entry.agentId), [DEFAULT_ID, 'cloud_agent_research', 'cloud_agent_unknown']);
  assert.equal(sessions[0]!.proactive, true);
  assert.equal(sessions[2]!.proactive, false);
  assert.deepEqual(normalizePersonalAgentSessions(null), []);
  assert.deepEqual(normalizePersonalAgentSessions({ agents: 'nope' }), []);
});

test('entries take names and avatars from the local agents and wait for unknown Factory agents', () => {
  const entries = joinPersonalAgents(sessions, [kordi, research], ACCOUNT);
  assert.deepEqual(entries.map((entry) => [entry.agentId, entry.name, entry.localAgentId, entry.isDefault]), [
    [DEFAULT_ID, "Alex's Kordi", 'desktop:local-agent', true],
    ['cloud_agent_research', 'Research agent', 'cloud-agent:cloud_agent_research', false],
  ]);
  assert.equal(entries[1]!.avatarSeed, 'owl-seed');
  assert.equal(entries[1]!.profileImageUrl, 'https://avatars.test/owl.png');
  // The default agent still shows when the local agent list has not loaded yet.
  assert.equal(joinPersonalAgents(sessions, [], ACCOUNT)[0]!.name, 'Kordi');
});

test('a conversation matches its personal agent by session id, conversation id or marker', () => {
  const entries = joinPersonalAgents(sessions, [kordi, research], ACCOUNT);
  const byId = (id: string, metadata?: unknown) => ({ id, canonicalSessionId: id, metadata }) as Pick<Conversation, 'id' | 'canonicalSessionId' | 'metadata'>;
  assert.equal(personalAgentEntryForConversation(entries, byId(RESEARCH_SESSION))?.agentId, 'cloud_agent_research');
  assert.equal(personalAgentEntryForConversation(entries, byId('conv-kordi'))?.agentId, DEFAULT_ID);
  assert.equal(personalAgentEntryForConversation(entries, byId('session:other', { personalAgent: { agentId: 'cloud_agent_research' } }))?.agentId, 'cloud_agent_research');
  assert.equal(personalAgentEntryForConversation(entries, byId('session:other')), null);
  assert.equal(personalAgentMarker({ personalAgent: { agentId: ' a ' } }), 'a');
  assert.equal(personalAgentMarker({ personalAgent: 'a' }), null);
  // The marker alone identifies a personal session before the list loads.
  assert.equal(isPersonalAgentConversation([], byId('session:x', { personalAgent: { agentId: 'cloud_agent_x' } })), true);
  assert.equal(isPersonalAgentConversation([], byId('session:x')), false);
});

function canonicalState(sessions: CanonicalSessionState['sessions'] = []): CanonicalSessionState {
  return {
    profile: { humanIdentityId: 'human:alex', activeAgentIdentityId: 'agent:local' },
    identities: [
      { id: 'human:alex', kind: 'human', displayName: 'Alex' },
      { id: 'agent:local', kind: 'agent', displayName: "Alex's Kordi", ownerIdentityId: 'human:alex' },
    ],
    sessions,
    participants: [],
    messages: [],
    contextSnapshots: [],
  } as unknown as CanonicalSessionState;
}

test('each personal agent gets a local session under the server session id, set up like a chat with that agent', () => {
  const entries = joinPersonalAgents(sessions, [kordi, research], ACCOUNT);
  const plans = planPersonalAgentSessions(entries, [kordi, research], canonicalState());
  assert.equal(plans.length, 2);
  const [own, factory] = plans;
  assert.equal(own!.session.id, DEFAULT_SESSION);
  assert.equal(own!.session.kind, 'self-agent');
  assert.equal(own!.session.primaryIdentityId, 'agent:local');
  assert.equal(own!.identity, undefined);
  assert.deepEqual((own!.session.metadata as Record<string, unknown>).personalAgent, { agentId: DEFAULT_ID });
  assert.equal(factory!.session.id, RESEARCH_SESSION);
  assert.equal(factory!.session.kind, 'direct-agent');
  assert.equal(factory!.session.primaryIdentityId, factory!.identity?.id);
  const metadata = factory!.session.metadata as Record<string, unknown>;
  assert.equal(metadata.createdFrom, 'chat-create-flow');
  assert.equal(metadata.cloudAgentId, 'cloud_agent_research');
  assert.deepEqual(metadata.personalAgent, { agentId: 'cloud_agent_research' });
  assert.deepEqual(planPersonalAgentSessions(entries, [kordi, research], null), []);
});

test('a session that already carries its marker is left alone, and an existing one keeps its metadata', () => {
  const entries = joinPersonalAgents(sessions, [kordi, research], ACCOUNT);
  const marked = { id: DEFAULT_SESSION, kind: 'self-agent', title: "Alex's Kordi", status: 'active', primaryIdentityId: 'agent:local', metadata: { personalAgent: { agentId: DEFAULT_ID } } };
  const mirrored = { id: RESEARCH_SESSION, kind: 'self-agent', title: 'Lab sync moved', status: 'active', primaryIdentityId: 'agent:cloud-self:acct_alex', metadata: { cloudSelfAgentSession: true, sessionTitleSource: 'auto' } };
  const plans = planPersonalAgentSessions(entries, [kordi, research], canonicalState([marked, mirrored] as never));
  assert.deepEqual(plans.map((plan) => plan.session.id), [RESEARCH_SESSION]);
  const metadata = plans[0]!.session.metadata as Record<string, unknown>;
  assert.equal(metadata.sessionTitleSource, 'auto');
  assert.equal(metadata.cloudSelfAgentSession, true);
  assert.equal(plans[0]!.session.title, 'Lab sync moved');
  assert.equal(plans[0]!.session.kind, 'direct-agent');
});

const row = (sessionId: string, key = `session:${sessionId}`): ChatSidebarRow => ({ kind: 'session', key, sessionId, spaceId: 'self:local', depth: 0, activePath: false });

test('the Personal agent section lists every agent first and keeps its sessions out of Pinned and Recents', () => {
  const entries = joinPersonalAgents(sessions, [kordi, research], ACCOUNT);
  const sessionRows = new Map([
    [DEFAULT_SESSION, { session: { id: DEFAULT_SESSION, canonicalSessionId: DEFAULT_SESSION, title: "Alex's Kordi", preview: 'Lab sync moved to 10 am Thursday.', conversation: { id: DEFAULT_SESSION, canonicalSessionId: DEFAULT_SESSION, metadata: {} } } }],
    ['session:other', { session: { id: 'session:other', title: 'Figure script fix', preview: 'Patched it', conversation: { id: 'session:other' } } }],
  ]);
  const personal = personalAgentSidebarRows(entries, sessionRows);
  assert.deepEqual(personal.rows.map((entry) => entry.key), [`personal:${DEFAULT_ID}`, 'personal:cloud_agent_research']);
  assert.deepEqual([...personal.sessionIds], [DEFAULT_SESSION]);
  assert.equal(personal.rows[1]!.kind === 'session' && personal.rows[1]!.sessionId, RESEARCH_SESSION);
  assert.equal(personal.rows[0]!.estimatedHeight, 50);
  assert.equal(personalAgentIdFromRowKey(personal.rows[1]!.key), 'cloud_agent_research');
  assert.equal(personalAgentIdFromRowKey('recent:session:x'), null);

  const grouped = projectChatGroups([row(DEFAULT_SESSION), row('session:saved'), row('session:other')], [], new Set(), false, {
    pinnedSessionIds: new Set([DEFAULT_SESSION, 'session:saved']), personal,
  });
  assert.deepEqual(grouped.rows.map((entry) => entry.key), [
    'agent-section:personal', `personal:${DEFAULT_ID}`, 'personal:cloud_agent_research',
    'agent-section:pinned', 'pinned:session:session:saved',
    'agent-section:recents', 'recent:session:session:other',
  ]);
  assert.deepEqual(personalAgentSidebarRows(entries, sessionRows, 'research').rows.map((entry) => entry.key), ['personal:cloud_agent_research']);
  assert.deepEqual(personalAgentSidebarRows(entries, sessionRows, 'lab sync').rows.map((entry) => entry.key), [`personal:${DEFAULT_ID}`]);
});

test('a blank personal session is never reused or collapsed as a new chat shell', () => {
  const personal = {
    id: RESEARCH_SESSION, canonicalSessionId: RESEARCH_SESSION, name: 'Research agent', type: 'owned-agent', subtitle: '', unread: 0,
    collaborationSources: [], trust: 'Owned', directness: 'Agent chat', participants: [], messages: [],
    metadata: { agentId: research.id, cloudAgentId: 'cloud_agent_research', personalAgent: { agentId: 'cloud_agent_research' } },
    canonicalParticipants: [{ id: 'agent:research', name: 'Research agent', kind: 'agent', role: 'delegate', source: 'local', agentId: research.id }],
  } as unknown as Conversation;
  const blank = { ...personal, id: 'session:direct-agent:new', canonicalSessionId: 'session:direct-agent:new', metadata: { agentId: research.id, cloudAgentId: 'cloud_agent_research' } } as Conversation;
  assert.equal(existingBlankSessionIdForAgentStart(research, [personal]), null);
  assert.equal(existingBlankSessionIdForAgentStart(research, [personal, blank]), 'session:direct-agent:new');
  assert.deepEqual(collapseBlankConversationShells([personal, blank]).map((conversation) => conversation.id), [RESEARCH_SESSION, 'session:direct-agent:new']);
});

test('the entries store notifies only on a change', () => {
  const entries = joinPersonalAgents(sessions, [kordi, research], ACCOUNT);
  let calls = 0;
  const unsubscribe = subscribePersonalAgentEntries(() => { calls += 1; });
  setPersonalAgentEntries(entries);
  setPersonalAgentEntries(entries.map((entry) => ({ ...entry })) as PersonalAgentEntry[]);
  assert.equal(calls, 1);
  setPersonalAgentEntries([]);
  assert.equal(calls, 2);
  assert.equal(getPersonalAgentEntries().length, 0);
  unsubscribe();
});

test('an Agent settings request waits for the Agents page', () => {
  requestAgentBlueprint(' cloud-agent:cloud_agent_research ');
  assert.equal(pendingAgentBlueprintRequest(), 'cloud-agent:cloud_agent_research');
  requestAgentBlueprint('');
  assert.equal(pendingAgentBlueprintRequest(), null);
});

test('messages sent in a Factory agent personal session target that agent', async () => {
  const { cloudAgentTargetsBySessionId, cloudSyncedLocalAgentSessionIds } = await import('../src/features/cloud/cloudSelfAgentSessionIdentity');
  const entries = joinPersonalAgents(sessions, [kordi, research], ACCOUNT);
  const base = canonicalState();
  const plans = planPersonalAgentSessions(entries, [kordi, research], base);
  const state = {
    ...base,
    identities: [...base.identities, ...plans.flatMap((plan) => plan.identity ? [{ ...plan.identity, id: plan.identity.id! }] : [])],
    sessions: plans.map((plan) => ({ ...plan.session, id: plan.session.id! })),
  } as unknown as CanonicalSessionState;
  const synced = cloudSyncedLocalAgentSessionIds(state);
  assert.ok(synced.has(DEFAULT_SESSION));
  assert.ok(synced.has(RESEARCH_SESSION));
  const targets = cloudAgentTargetsBySessionId(state, synced);
  assert.deepEqual(targets.get(RESEARCH_SESSION), { targetAgentId: 'cloud_agent_research', targetAgentName: 'Research agent' });
  // The default agent's session goes to the owner's own agent, which needs no explicit target.
  assert.equal(targets.has(DEFAULT_SESSION), false);
});

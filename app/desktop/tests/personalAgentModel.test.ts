import assert from 'node:assert/strict';
import { test } from 'node:test';

import { existingBlankSessionIdForAgentStart } from '../src/features/chat/chatCreateFlows';
import { collapseBlankConversationShells } from '../src/features/chat/participantSpaces';
import { normalizePersonalAgentSessions } from '../src/features/personalAgent/personalAgentClient';
import {
  joinPersonalAgents,
  personalAgentEntryForConversation,
  personalAgentMarker,
} from '../src/features/personalAgent/personalAgentEntries';
import { planPersonalAgentSessions } from '../src/features/personalAgent/personalAgentSessions';
import { personalAgentIdFromRowKey, personalAgentSidebarRows } from '../src/features/personalAgent/personalAgentSidebarRows';
import { getPersonalAgentEntries, isPersonalAgentSession, setPersonalAgentEntries, subscribePersonalAgentEntries, type PersonalAgentEntry } from '../src/features/personalAgent/personalAgentStore';
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

test('entries take names and avatars from the local agents and keep agents the list does not hold yet', () => {
  const entries = joinPersonalAgents(sessions, [kordi, research], ACCOUNT);
  assert.deepEqual(entries.map((entry) => [entry.agentId, entry.name, entry.localAgentId, entry.isDefault]), [
    [DEFAULT_ID, "Alex's Kordi", 'desktop:local-agent', true],
    ['cloud_agent_research', 'Research agent', 'cloud-agent:cloud_agent_research', false],
    ['cloud_agent_unknown', 'Agent', null, false],
  ]);
  assert.equal(entries[1]!.avatarSeed, 'owl-seed');
  assert.equal(entries[1]!.profileImageUrl, 'https://avatars.test/owl.png');
  // The default agent still shows when the local agent list has not loaded yet.
  assert.equal(joinPersonalAgents(sessions, [], ACCOUNT)[0]!.name, 'Kordi');
});

test('a conversation matches its personal agent by session or conversation id; its marker counts only until a list loads', () => {
  const entries = joinPersonalAgents(sessions, [kordi, research], ACCOUNT);
  const byId = (id: string, metadata?: unknown) => ({ id, canonicalSessionId: id, metadata }) as Pick<Conversation, 'id' | 'canonicalSessionId' | 'metadata'>;
  assert.equal(personalAgentEntryForConversation(entries, byId(RESEARCH_SESSION))?.agentId, 'cloud_agent_research');
  assert.equal(personalAgentEntryForConversation(entries, byId('conv-kordi'))?.agentId, DEFAULT_ID);
  // A marked session that is not the listed one (an old session) is an ordinary chat.
  assert.equal(personalAgentEntryForConversation(entries, byId('session:other', { personalAgent: { agentId: 'cloud_agent_research' } })), null);
  assert.equal(personalAgentEntryForConversation(entries, byId('session:other')), null);
  assert.equal(personalAgentMarker({ personalAgent: { agentId: ' a ' } }), 'a');
  assert.equal(personalAgentMarker({ personalAgent: 'a' }), null);
  assert.equal(personalAgentMarker({ personalAgent: null }), null);
  // The marker alone identifies a personal session before any list loads.
  const marked = byId('session:x', { personalAgent: { agentId: 'cloud_agent_x' } });
  assert.equal(personalAgentEntryForConversation([], marked, { markerFallback: true })?.agentId, 'cloud_agent_x');
  assert.equal(personalAgentEntryForConversation([], marked), null);
  setPersonalAgentEntries([], false);
  assert.equal(isPersonalAgentSession('session:x', marked.metadata), true);
  assert.equal(isPersonalAgentSession('session:x'), false);
  setPersonalAgentEntries(entries, true);
  try {
    assert.equal(isPersonalAgentSession('session:unknown'), true);
    assert.equal(isPersonalAgentSession('conv-research'), true);
    // Once a list has loaded, a marker of an agent that left it no longer counts.
    assert.equal(isPersonalAgentSession('session:x', marked.metadata), false);
  } finally {
    setPersonalAgentEntries([], false);
  }
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

function sessionRow(id: string, title: string, preview: string, metadata?: unknown, agentName = "Alex's Kordi") {
  const conversation = {
    id, canonicalSessionId: id, name: title, type: 'owned-agent', subtitle: preview, unread: 0, collaborationSources: [], trust: 'Owned',
    directness: 'Agent chat', participants: ['Me', agentName], messages: [], metadata,
    canonicalParticipants: [
      { id: 'human:alex', name: 'Me', kind: 'human', role: 'self', source: 'local' },
      { id: `agent:${agentName}`, name: agentName, kind: 'agent', role: 'delegate', source: 'local', avatarKey: `seed-${agentName}` },
    ],
  } as unknown as Conversation;
  return [id, { session: { id, canonicalSessionId: id, title, preview, conversation }, space: { title: 'Agent chats', participants: [{ name: 'Me' }, { name: agentName }] } }] as const;
}

test('the Personal agent section lists every agent first and keeps its sessions out of Pinned and Recents', () => {
  const entries = joinPersonalAgents(sessions, [kordi, research], ACCOUNT);
  const sessionRows = new Map([
    sessionRow(DEFAULT_SESSION, "Alex's Kordi", 'Lab sync moved to 10 am Thursday.'),
    sessionRow('session:other', 'Figure script fix', 'Patched it'),
  ]);
  const personal = personalAgentSidebarRows(entries, sessionRows);
  assert.deepEqual(personal.rows.map((entry) => entry.key), [`personal:${DEFAULT_ID}`, 'personal:cloud_agent_research', 'personal:cloud_agent_unknown']);
  // Every listed session stays out of the other sections, loaded agent or not.
  assert.deepEqual([...personal.sessionIds].sort(), [DEFAULT_SESSION, RESEARCH_SESSION, 'conv-kordi', 'conv-research', 'conv-unknown', 'session:unknown'].sort());
  assert.equal(personal.rows[1]!.kind === 'session' && personal.rows[1]!.sessionId, RESEARCH_SESSION);
  assert.equal(personal.rows[0]!.estimatedHeight, 50);
  assert.equal(personal.entriesByAgentId.get('cloud_agent_unknown')?.localAgentId, null);
  assert.equal(personalAgentIdFromRowKey(personal.rows[1]!.key), 'cloud_agent_research');
  assert.equal(personalAgentIdFromRowKey('recent:session:x'), null);

  const grouped = projectChatGroups([row(DEFAULT_SESSION), row('session:saved'), row('session:other'), row('session:unknown')], [], new Set(), false, {
    pinnedSessionIds: new Set([DEFAULT_SESSION, 'session:saved']), personal,
  });
  assert.deepEqual(grouped.rows.map((entry) => entry.key), [
    'agent-section:personal', `personal:${DEFAULT_ID}`, 'personal:cloud_agent_research', 'personal:cloud_agent_unknown',
    'agent-section:pinned', 'pinned:session:session:saved',
    'agent-section:recents', 'recent:session:session:other',
  ]);
});

test('an unloaded listed agent shows with the session name; a marked session counts only before a list loads', () => {
  const entries = joinPersonalAgents(sessions, [kordi], ACCOUNT);
  const sessionRows = new Map([
    sessionRow(RESEARCH_SESSION, 'Two new papers', 'Two new papers cite your draft.', { personalAgent: { agentId: 'cloud_agent_research' } }, 'Research agent'),
    sessionRow('session:marked-only', 'Inbox', 'Nothing new.', { personalAgent: { agentId: 'cloud_agent_inbox' } }, 'Inbox helper'),
  ]);
  const personal = personalAgentSidebarRows(entries, sessionRows);
  assert.deepEqual(personal.rows.map((entry) => entry.key), [`personal:${DEFAULT_ID}`, 'personal:cloud_agent_research', 'personal:cloud_agent_unknown']);
  assert.equal(personal.entriesByAgentId.get('cloud_agent_research')?.name, 'Research agent');
  assert.equal(personal.entriesByAgentId.get('cloud_agent_research')?.localAgentId, null);
  // Inbox helper's Proactive is off: its old session goes back to the other sections.
  assert.equal(personal.sessionIds.has('session:marked-only'), false);
  const beforeList = personalAgentSidebarRows([], sessionRows, '', { markerFallback: true });
  assert.deepEqual(beforeList.rows.map((entry) => entry.key), ['personal:cloud_agent_research', 'personal:cloud_agent_inbox']);
  assert.equal(beforeList.entriesByAgentId.get('cloud_agent_inbox')?.name, 'Inbox helper');
  assert.ok(beforeList.sessionIds.has('session:marked-only'));
});

test('searching keeps a personal row whose session matches like any other session', () => {
  const entries = joinPersonalAgents(sessions, [kordi, research], ACCOUNT);
  const sessionRows = new Map([
    sessionRow(DEFAULT_SESSION, 'Conference travel', 'Lab sync moved to 10 am Thursday.'),
    sessionRow(RESEARCH_SESSION, 'Reading list', 'Two new papers.', undefined, 'Research agent'),
  ]);
  const keys = (search: string) => personalAgentSidebarRows(entries, sessionRows, search).rows.map((entry) => entry.key);
  // By title, preview, agent name, or a participant.
  assert.deepEqual(keys('conference'), [`personal:${DEFAULT_ID}`]);
  assert.deepEqual(keys('lab sync'), [`personal:${DEFAULT_ID}`]);
  assert.deepEqual(keys('research'), ['personal:cloud_agent_research']);
  assert.deepEqual(keys('agent chats'), [`personal:${DEFAULT_ID}`, 'personal:cloud_agent_research']);
  assert.deepEqual(keys('nothing matches'), []);
  // Searching does not let a personal session reach the other sections.
  assert.ok(personalAgentSidebarRows(entries, sessionRows, 'nothing matches').sessionIds.has(DEFAULT_SESSION));
});

test('forks of a personal session move to the top level of the other sections', () => {
  const personal = { rows: [], sessionIds: new Set([DEFAULT_SESSION]) };
  const rows: ChatSidebarRow[] = [
    { ...row(DEFAULT_SESSION) },
    { ...row('session:fork-a'), depth: 1 },
    { ...row('session:fork-a-1'), depth: 2 },
    { ...row('session:fork-b'), depth: 1 },
    { ...row('session:other') },
    { ...row('session:other-fork'), depth: 1 },
  ];
  const grouped = projectChatGroups(rows, [], new Set(), false, { personal });
  assert.deepEqual(grouped.rows.filter((entry) => entry.kind === 'session').map((entry) => [entry.kind === 'session' && entry.sessionId, entry.depth]), [
    ['session:fork-a', 0], ['session:fork-a-1', 1], ['session:fork-b', 0], ['session:other', 0], ['session:other-fork', 1],
  ]);
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

test('the Personal agent section folds like Recents and a search shows its matches while folded', () => {
  const personalRow = (agentId: string): ChatSidebarRow => ({ kind: 'session', key: `personal:${agentId}`, sessionId: `session:${agentId}`, spaceId: 'personal', depth: 0, activePath: false, estimatedHeight: 50 });
  const personal = { rows: [personalRow('a'), personalRow('b')], sessionIds: new Set(['session:a', 'session:b']) };
  const keys = (collapsed: Set<string>, showWhileCollapsed = false) => projectChatGroups([row('session:other')], [], collapsed, false, { personal: { ...personal, showWhileCollapsed } })
    .rows.map((entry) => entry.key);
  assert.deepEqual(keys(new Set()), ['agent-section:personal', 'personal:a', 'personal:b', 'agent-section:recents', 'recent:session:session:other']);
  // Folded: the heading stays, its rows hide, the other sections are untouched.
  assert.deepEqual(keys(new Set(['section:personal'])), ['agent-section:personal', 'agent-section:recents', 'recent:session:session:other']);
  assert.deepEqual(keys(new Set(['section:personal']), true), ['agent-section:personal', 'personal:a', 'personal:b', 'agent-section:recents', 'recent:session:session:other']);
});

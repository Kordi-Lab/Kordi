import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { CloudAuthClient } from '../src/features/cloud/authClient';
import type { NativeAgentSubsession } from '../src/features/cloud/agentSubsessionTypes';
import { publishModelSubsessions } from '../src/features/cloud/agentSubsessionSync';
import { deriveCloudActivityFromTurn } from '../src/features/cloud/cloudSessionActivity';
import { subsessionMentionOptions, subsessionMentions, subsessionTranscript } from '../src/features/cloud/subsessionConversation';
import type { CloudAgentSubsession } from '../src/features/cloud/agentSubsessionTypes';

test('iOS keeps the native child-chat navigation and the existing ConversationView', () => {
  const navigation = readFileSync(new URL('../../ios/Kordi/Features/Conversation/ConversationView.swift', import.meta.url), 'utf8');
  const destination = readFileSync(new URL('../../ios/Kordi/Features/Conversation/AgentSubsessionView.swift', import.meta.url), 'utf8');
  assert.match(navigation, /\.navigationDestination\(item: \$selectedBackgroundSession\)/);
  assert.match(destination, /ConversationView\(conversation: snapshot\.conversation/);
  assert.doesNotMatch(destination, /MarkdownMessageContent|\.sheet\(|\.fullScreenCover\(/);
});

test('shared follow-ups preserve identity and never show a queued or unadmitted request as processing', () => {
  const record: CloudAgentSubsession = { sessionId: 'child', parentSessionId: 'parent', parentRequestId: 'root',
    ownerAccountId: 'owner', agentId: 'agent-one', ownerDisplayName: 'Owner One', agentDisplayName: "Owner One's Kordi",
    title: 'Research', status: 'running', version: 2, updatedAt: '', hasFollowupExecution: true, participants: [],
    messages: [
      { id: 'plain', role: 'user', senderAccountId: 'peer', text: 'Hello everyone', timestampMs: 1 },
      { id: 'a', role: 'user', senderAccountId: 'peer', text: '@KordiOwnerOne explain', timestampMs: 2, requestState: 'running' },
      { id: 'reply:a', role: 'assistant', text: '', timestampMs: 3, requestId: 'a', requestState: 'running' },
      { id: 'b', role: 'user', senderAccountId: 'owner', text: '@KordiOwnerOne summarize', timestampMs: 4, requestState: 'queued' },
      { id: 'reply:b', role: 'assistant', text: '', timestampMs: 5, requestId: 'b', requestState: 'queued' },
      { id: 'reply:pending', role: 'assistant', text: '', timestampMs: 6, requestState: 'pending' },
    ] };
  const options = subsessionMentionOptions(record, 'peer');
  assert.equal(options[0].value, 'KordiOwnerOne');
  assert.deepEqual(subsessionMentions('Hello everyone', options), []);
  assert.equal(subsessionMentions('@KordiOwnerOne explain', options)[0].agentId, record.agentId);
  assert.deepEqual(subsessionMentions('@KordiOwnerOneOther explain', options), []);
  const rows = subsessionTranscript(record, 'peer');
  assert.equal(rows.filter(row => row.turn).length, 1);
  assert(!rows.some(row => row.id === 'reply:b' || row.id === 'reply:pending'));
  assert.equal(rows.find(row => row.id === 'plain')?.role, 'user');
  assert.equal(rows.find(row => row.id === 'b')?.role, 'person');
  assert.equal(rows.find(row => row.id === 'reply:a')?.senderIdentityId, record.agentId);
  const renamed = subsessionMentionOptions({ ...record, agentDisplayName: 'Researcher' }, 'peer');
  assert.equal(subsessionMentions('@ResearcherOwnerOne continue', renamed)[0].agentId, record.agentId);
  const stale = subsessionTranscript({ ...record, live: false }, 'peer');
  assert(!stale.some(row => row.turn?.completed === false));
  assert(stale.some(row => row.id === 'b'), 'queued human follow-ups remain visible');
});

test('subsession synchronization uses the execution resource without creating conversations', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new CloudAuthClient({ baseUrl: 'http://127.0.0.1:17081', fetchImpl: async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ sessionId: 'subsession', version: 1 }), { headers: { 'content-type': 'application/json' } });
  } });
  const snapshot: NativeAgentSubsession = { sessionId: 'subsession', parentSessionId: 'parent', parentRequestId: 'request', title: 'Model task', status: 'done', messages: [{ id: 'entry', role: 'assistant', text: 'Result', timestampMs: 1000 }] };
  await client.putAgentSubsession('test-token', snapshot, 0);
  await client.getAgentSubsession('test-token', snapshot.sessionId, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init?.method, 'PUT');
  assert.match(requests[0].url, /\/v1\/cloud\/agent-subsessions\/subsession$/);
  assert.match(requests[1].url, /includeMessages=true$/);
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    parentSessionId: 'parent', parentRequestId: 'request', title: 'Model task', status: 'done', messages: snapshot.messages, expectedVersion: 0,
  });
  assert(requests.every((request) => !request.url.includes('/conversations')));
});

test('subsession avatars come from stable member and Agent profiles, not account-derived pictures', () => {
  const record: CloudAgentSubsession = { sessionId: 'child', parentSessionId: 'parent', parentRequestId: 'root',
    ownerAccountId: 'owner', agentId: 'agent-one', ownerDisplayName: 'Same name', agentDisplayName: 'Researcher',
    agentAvatarUrl: 'https://example.test/agent.png', title: 'Research', status: 'done', version: 1, updatedAt: '',
    participants: [
      { accountId: 'owner', displayName: 'Same name', avatarUrl: 'https://example.test/owner.png', avatarSeed: 'owner-picture' },
      { accountId: 'peer', displayName: 'Same name', avatarUrl: 'https://example.test/peer.png', avatarSeed: 'peer-picture' },
    ], messages: [
      { id: 'human', role: 'user', senderAccountId: 'peer', text: 'Hello', timestampMs: 1 },
      { id: 'agent', role: 'assistant', text: 'Answer', timestampMs: 2 },
    ] };
  const options = subsessionMentionOptions(record, 'owner');
  assert.equal(options.length, 2);
  assert.equal(options[1].humanId, 'peer');
  assert.equal(options[1].avatarImageUrl, record.participants?.[1].avatarUrl);
  assert.equal(options[1].avatarSeed, 'peer-picture');
  assert.equal(options[0].avatarImageUrl, record.agentAvatarUrl);
  const [person, agent] = subsessionTranscript(record, 'owner');
  assert.equal(person.senderProfileImageUrl, record.participants?.[1].avatarUrl);
  assert.equal(person.senderIdentityId, 'peer');
  assert.equal(agent.senderProfileImageUrl, record.agentAvatarUrl);
  assert.equal(agent.senderIdentityId, record.agentId);
});

test('Agent task instructions are attributed by ID for every member without becoming live answers', () => {
  const record: CloudAgentSubsession = { sessionId: 'child', parentSessionId: 'parent', parentRequestId: 'root',
    ownerAccountId: 'owner', agentId: 'agent-one', ownerDisplayName: 'Owner', agentDisplayName: 'Researcher',
    agentAvatarUrl: 'https://example.test/agent.png', title: 'Research', status: 'running', version: 1, updatedAt: '',
    messages: [
      { id: 'brief', role: 'user', senderAgentId: 'agent-one', text: 'Compare sources', timestampMs: 1 },
      { id: 'human', role: 'user', senderAccountId: 'peer', senderDisplayName: 'Peer', text: 'Follow', timestampMs: 2, requestState: 'queued' },
    ] };
  for (const account of ['owner', 'peer']) {
    const [brief, progress, human] = subsessionTranscript(record, account);
    assert.equal(brief.role, account === 'owner' ? 'owned-agent' : 'external-agent');
    assert.equal(brief.sender, 'Researcher');
    assert.equal(brief.senderIdentityId, record.agentId);
    assert.equal(brief.senderProfileImageUrl, record.agentAvatarUrl);
    assert.equal(brief.senderOwnerName, account === 'owner' ? 'You' : 'Owner');
    assert.equal(brief.turn, undefined);
    assert.equal(progress.id, 'runtime:child');
    assert.equal(progress.turn?.completed, false);
    assert.equal(human.senderIdentityId, 'peer');
    assert.equal(human.role, account === 'peer' ? 'user' : 'person');
    assert.deepEqual(human.statusChips, ['queued']);
  }
  record.messages.push({ id: 'answer', role: 'assistant', text: 'Sources found', timestampMs: 3 });
  assert.equal(subsessionTranscript(record, 'peer').at(-1)?.turn?.assistantText, 'Sources found');
  record.status = 'done';
  assert.equal(subsessionTranscript(record, 'peer').filter(row => row.turn).length, 0);
  record.messages[0].senderAgentId = 'unrelated-agent';
  assert.equal(subsessionTranscript(record, 'peer')[0].senderType, 'human');
});

test('ordinary answers do not synthesize a subsession or a task card', async () => {
  await publishModelSubsessions({ tools: [] });
  await publishModelSubsessions({ tools: [{ id: 'plan', name: 'task_operator', status: 'completed', arguments: '{"action":"create"}', liveOutput: '', resultText: 'Task created', isError: false }] });
});

test('real subsessions do not leave permanently active duplicate planning tasks', () => {
  const result = deriveCloudActivityFromTurn({ sessionId: 'parent', localAccountId: 'owner', participantAccountIds: ['owner', 'peer'], turn: {
    id: 'parent-turn', sessionId: 'parent', prompt: 'Research', status: 'succeeded', message: '', assistantText: 'Started', thinkingText: '', completed: true, succeeded: true,
    tools: [{ id: 'spawn', name: 'task_operator', status: 'completed', arguments: '{"action":"spawn","task_name":"research","taskTitle":"Research"}', liveOutput: '', isError: false,
      resultText: 'Background session: {"sessionId":"child","title":"Research","status":"running"}' }],
  } });
  assert.equal(result.tasks.length, 0);
});

test('Cloud tool progress renders as one activity row, never one message per tool call', () => {
  const tool = (id: string, name: string, status: string) => ({ id, name, status, arguments: '', liveOutput: '', isError: false });
  const record: CloudAgentSubsession = { sessionId: 'child', parentSessionId: 'parent', parentRequestId: 'root',
    ownerAccountId: 'owner', agentId: 'agent-one', ownerDisplayName: 'Owner', agentDisplayName: 'Researcher',
    title: 'Research', status: 'running', version: 4, updatedAt: '', live: true,
    activity: { tools: [tool('a', 'search_sessions', 'completed'), tool('b', 'read_session', 'running')] },
    messages: [{ id: 'brief', role: 'user', senderAgentId: 'agent-one', text: 'Compare sources', timestampMs: 1 }] };
  const running = subsessionTranscript(record, 'owner');
  assert.equal(running.length, 2);
  assert.equal(running[1].turn?.completed, false);
  assert.deepEqual(running[1].turn?.tools.map(item => [item.name, item.status]), [['search_sessions', 'completed'], ['read_session', 'running']]);
  record.status = 'done';
  record.messages.push({ id: 'result:run', role: 'assistant', text: 'Final answer', timestampMs: 9 });
  const done = subsessionTranscript(record, 'owner');
  assert.equal(done.length, 2);
  assert.equal(done[1].text, 'Final answer');
  assert.equal(done[1].turn?.completed, true);
  assert.equal(done[1].turn?.assistantText, 'Final answer');
  assert(done[1].turn?.tools.every(item => item.status === 'completed'));
});

test('stored per-tool progress messages collapse into one row', () => {
  const legacy = Array.from({ length: 30 }, (_, index) => ({ id: `tool:call-${index}`, role: 'assistant' as const,
    text: index % 3 ? 'Using search_sessions…' : 'Using read_session…', timestampMs: 2 + index }));
  const record: CloudAgentSubsession = { sessionId: 'child', parentSessionId: 'parent', parentRequestId: 'root',
    ownerAccountId: 'owner', agentId: 'agent-one', ownerDisplayName: 'Owner', agentDisplayName: 'Researcher',
    title: 'Research', status: 'running', version: 40, updatedAt: '', live: true, activity: { tools: [] },
    messages: [{ id: 'brief', role: 'user', senderAgentId: 'agent-one', text: 'Compare sources', timestampMs: 1 }, ...legacy] };
  const running = subsessionTranscript(record, 'owner');
  assert.equal(running.length, 2);
  assert(!running.some(row => row.text.startsWith('Using ')));
  assert.equal(running[1].turn?.tools.length, 30);
  assert.equal(running[1].turn?.completed, false);
  assert.equal(running[1].turn?.tools.at(-1)?.status, 'running');
  record.status = 'done';
  record.messages.push({ id: 'result:run', role: 'assistant', text: 'Final answer', timestampMs: 99 });
  const done = subsessionTranscript(record, 'owner');
  assert.deepEqual(done.map(row => row.id), ['brief', 'result:run']);
  assert.equal(done[1].turn?.tools.length, 30);
  assert.equal(done[1].turn?.completed, true);
  assert.equal(done[1].turn?.tools[1].name, 'search_sessions');
});

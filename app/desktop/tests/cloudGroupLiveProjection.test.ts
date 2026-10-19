import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCloudGroupLiveTurns, projectCloudSelfAgentLiveTurns } from '../src/features/cloud/cloudGroupLiveProjection';
import { cloudGroupAgentRuntimeSessionId } from '../src/features/cloud/cloudAgentRuntime';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import type { CanonicalSessionState, DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const state = {
  profile: { humanIdentityId: 'human:owner' },
  identities: [{ id: 'agent:owner', kind: 'agent', ownerIdentityId: 'human:owner', displayName: 'Synthetic Agent' }],
  sessions: [{ id: 'group', kind: 'group' }],
  messages: [{ id: 'processing-slot', sessionId: 'group', senderIdentityId: 'agent:owner', senderRole: 'owned-agent',
    messageKind: 'agent-turn', parentMessageId: 'request', sourceTransport: 'cloud-group-agent', status: 'processing',
    contentText: '', content: { deliveryState: 'processing', requestId: 'request' }, createdAtMs: 1000, sequenceNum: 2 }],
} as CanonicalSessionState;
const turn: DesktopChatTurnSnapshot = {
  id: 'runtime-turn', sessionId: `${cloudGroupAgentRuntimeSessionId('owner', 'group')}:request:request`,
  replyToMessageId: 'request', prompt: '', status: 'using-tool', message: '', assistantText: '', thinkingText: '',
  completed: false, succeeded: false, startedAtMs: 1500,
  tools: [{ id: 'call-one', name: 'bash', arguments: '{"command":"synthetic command"}', liveOutput: 'Synthetic output', status: 'done', isError: false }],
};

test('group owner sees tool-only live progress on the same canonical row', () => {
  const projected = projectCloudGroupLiveTurns(state, { request: turn }, 'owner')!;
  assert.equal(state.messages[0].content.tools, undefined);
  assert.equal(projected.messages[0].id, state.messages[0].id);
  assert.equal(projected.messages[0].createdAtMs, 1000);
  const mapped = mapCanonicalMessage(projected.messages[0], new Map(projected.identities.map(identity => [identity.id, identity])), 'human:owner')!;
  assert.equal(mapped.turn?.tools.length, 1);
  assert.equal(mapped.turn?.tools[0].id, turn.tools[0].id);
  assert.equal(mapped.turn?.tools[0].liveOutput, 'Synthetic output');
  assert.equal(mapped.turn?.status, 'using-tool');
  assert.equal(mapped.turn?.startedAtMs, 1500);
  assert.equal(mapped.turn?.id, 'canonical-turn:processing-slot');
});

test('public processing refresh cannot blank local streaming progress', () => {
  for (const completed of [false, true]) {
    const visible = projectCloudGroupLiveTurns(state, { request: { ...turn, assistantText: 'Current answer', completed, succeeded: completed } }, 'owner')!;
    assert.equal(visible.messages[0].contentText, 'Current answer');
    assert.deepEqual(visible.messages[0].content.tools, turn.tools);
  }
});

test('peer, account, request, and group boundaries cannot project private progress', () => {
  const peer = { ...state, profile: { ...state.profile, humanIdentityId: 'human:peer' } };
  assert.equal(projectCloudGroupLiveTurns(peer, { request: turn }, 'owner'), peer);
  assert.equal(projectCloudGroupLiveTurns(state, { request: turn }, 'different-account'), state);
  for (const altered of [{ ...turn, replyToMessageId: 'other' }, { ...turn, sessionId: `${cloudGroupAgentRuntimeSessionId('owner', 'other-group')}:request:request` }]) {
    assert.equal(projectCloudGroupLiveTurns(state, { request: altered }, 'owner'), state);
  }
});

test('authoritative terminal replies and subsequent edits win over retained local snapshots', () => {
  const final = { ...state, messages: [{ ...state.messages[0], status: 'received', contentText: 'Edited public answer', content: { deliveryState: 'complete' } }] };
  assert.equal(projectCloudGroupLiveTurns(final, { request: { ...turn, completed: true, assistantText: 'Old answer' } }, 'owner'), final);
});

const selfState = {
  profile: { humanIdentityId: 'human:owner' },
  identities: [{ id: 'agent:cloud-self:owner', kind: 'agent', ownerIdentityId: 'human:owner', displayName: 'Named agent' }],
  sessions: [{ id: 'self-session', kind: 'self-agent' }],
  messages: [{ id: 'msg:cloud:self:response:request', sessionId: 'self-session', senderIdentityId: 'agent:cloud-self:owner',
    senderRole: 'owned-agent', messageKind: 'agent-turn', parentMessageId: 'local-request', sourceTransport: 'cloud-self-agent',
    status: 'processing', contentText: '', createdAtMs: 1000, sequenceNum: 2,
    content: { deliveryState: 'processing', cloudRequestMessageId: 'request', requestId: 'local-request' } }],
} as CanonicalSessionState;
const runningCommand: DesktopChatTurnSnapshot = {
  id: 'runtime-turn', sessionId: 'self-session', prompt: '', status: 'tooling', message: 'Running tool…',
  assistantText: '', thinkingText: '', completed: false, succeeded: false, startedAtMs: 1500,
  tools: [{ id: 'call-du', name: 'bash', arguments: '{"command":"du -x -k -d 1 ."}', liveOutput: '', status: 'running', isError: false }],
};

test('a self-agent request run on this Mac shows its running command before any output or publish', () => {
  const projected = projectCloudSelfAgentLiveTurns(selfState, { request: runningCommand })!;
  const mapped = mapCanonicalMessage(projected.messages[0], new Map(projected.identities.map(identity => [identity.id, identity])), 'human:owner')!;
  assert.equal(mapped.turn?.tools.length, 1);
  assert.equal(mapped.turn?.tools[0].status, 'running');
  assert.equal(mapped.turn?.tools[0].arguments, runningCommand.tools[0].arguments);
  assert.equal(mapped.turn?.status, 'tooling');
});

test('self-agent progress stays on its own request, session, and owner', () => {
  assert.equal(projectCloudSelfAgentLiveTurns(selfState, { other: runningCommand }), selfState);
  assert.equal(projectCloudSelfAgentLiveTurns(selfState, { request: { ...runningCommand, sessionId: 'other-session' } }), selfState);
  const peer = { ...selfState, profile: { humanIdentityId: 'human:peer' } } as CanonicalSessionState;
  assert.equal(projectCloudSelfAgentLiveTurns(peer, { request: runningCommand }), peer);
  const final = { ...selfState, messages: [{ ...selfState.messages[0], status: 'received', contentText: 'Done', content: { ...selfState.messages[0].content as object, deliveryState: 'complete' } }] } as CanonicalSessionState;
  assert.equal(projectCloudSelfAgentLiveTurns(final, { request: runningCommand }), final);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeConversationForSelection } from '../src/app/viewModels/conversationSelection';
import { nativeChatPlaceholderForSelection } from '../src/app/viewModels/nativeChatSelection';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { canChooseChatProject } from '../src/features/projects/chatProjects';
import type { Conversation } from '../src/kordi-app/types';

const sessionId = '9520f4d5-5a9b-426e-a5f7-60f22a570b99';
const cloudMirrorId = `cloud:conversation:acct_owner:agent:session:${sessionId}`;

const canonicalState = {
  storagePath: '/tmp/canonical.sqlite3',
  profile: { id: 'profile:me', displayName: 'Me', humanIdentityId: 'human:me', activeAgentIdentityId: 'agent:local', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
  identities: [
    { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
    { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
  ],
  sessions: [
    { id: sessionId, kind: 'self-agent', title: 'project chat', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:local', relationshipIdentityId: null, metadata: {}, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
  ],
  participants: [
    { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
  ],
  messages: [
    { id: 'msg:1', sessionId, senderIdentityId: 'human:me', senderRole: 'self', messageKind: 'text', contentText: 'hello', content: { sender: 'Me', timeLabel: '10:00' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'm1' },
    { id: 'msg:2', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'hi', content: { sender: 'Kordi', timeLabel: '10:00' }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'm2' },
  ],
  delegatedExchanges: [],
  presence: [],
  contextSnapshots: [],
};

function desktopEntry(updatedAtMs: number, transcriptLoaded: boolean) {
  return {
    id: sessionId,
    canonicalSessionId: sessionId,
    localSessionCwd: '/Users/example/KordiWorktrees',
    metadata: { projectRoot: '/Users/example/KordiWorktrees' },
    desktopRuntimeBacked: true,
    desktopRuntimeTranscriptLoaded: transcriptLoaded,
    name: 'project chat',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Agent chat',
    participants: ['Me', 'Kordi'],
    messages: [{ role: 'user', sender: 'Me', text: 'hello', time: '10:00' }],
    _updatedAtMs: updatedAtMs,
  };
}

function cloudMirror(updatedAtMs: number) {
  return {
    id: cloudMirrorId,
    canonicalSessionId: sessionId,
    name: 'project chat',
    type: 'external-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Cloud',
    directness: 'Agent chat',
    participants: ['Me', 'Kordi'],
    collaborationTarget: { hostId: 'cloud', nodeId: 'acct_owner', displayName: 'Kordi', ownerName: 'Me', runtime: 'kordi-desktop', humanId: 'acct_owner', agentId: 'agent:local' },
    messages: [{ role: 'user', sender: 'Me', text: 'hello', time: '10:00' }],
    _updatedAtMs: updatedAtMs,
  };
}

function selectedFor(entries: Array<Record<string, unknown>>): Conversation {
  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  // Same ordering as useWorkspaceViewModels: newest activity first.
  const merged = [...entries].sort((a, b) => Number(b._updatedAtMs ?? 0) - Number(a._updatedAtMs ?? 0));
  const chatConversations = readModel.buildChatConversations(merged as never, (messages, fallback) => messages[0]?.text ?? fallback ?? '');
  return activeConversationForSelection(sessionId, chatConversations, {
    isNativeShell: true,
    nativeChatPlaceholder: nativeChatPlaceholderForSelection(sessionId),
  });
}

test('desktop session keeps its identity and project controls while its cloud mirror moves around a send', () => {
  const phases = {
    // Before the send the cloud mirror carries the latest activity.
    before: [desktopEntry(100, false), cloudMirror(200)],
    // The send bumps the desktop session ahead while its transcript is not loaded yet.
    during: [desktopEntry(300, false), cloudMirror(200)],
    // The forwarded turn lands on the cloud mirror again.
    after: [desktopEntry(300, true), cloudMirror(400)],
  };
  for (const [phase, entries] of Object.entries(phases)) {
    const selected = selectedFor(entries);
    assert.equal(selected.id, sessionId, `${phase}: transcript and composer key`);
    assert.equal(selected.canonicalSessionId ?? selected.id, sessionId, `${phase}: session key`);
    assert.equal(canChooseChatProject(selected), true, `${phase}: workspace controls stay rendered`);
    assert.equal(selected.localSessionCwd, '/Users/example/KordiWorktrees', `${phase}: project binding`);
  }
});

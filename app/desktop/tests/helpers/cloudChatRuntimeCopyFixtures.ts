import { activeConversationForSelection } from '../../src/app/viewModels/conversationSelection';
import { nativeChatPlaceholderForSelection } from '../../src/app/viewModels/nativeChatSelection';
import { createCanonicalSessionReadModel } from '../../src/features/canonical/sessionReadModel';
import { localProjectSessions } from '../../src/features/projects/localProjectSessions';
import type { Conversation, DesktopChatState } from '../../src/kordi-app/types';

// A cloud agent chat that this Mac opens and runs, and a saved local chat that cloud sync
// also marks as a cloud agent session.
export const cloudChatId = '4c1d1d7e-58c4-4f43-9a51-1f0f6d2a7c11';
export const localChatId = '7b0f3f8e-2c55-4d0e-8a07-5f1c9b8a6d22';
const cloudMetadata = { cloudSelfAgentSession: true };

function canonicalSession(id: string, title: string, updatedAtMs: number) {
  return { id, kind: 'self-agent', title, status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:cloud-self', relationshipIdentityId: null, metadata: cloudMetadata, createdAtMs: 1, updatedAtMs, lastMessageAtMs: updatedAtMs };
}

function canonicalMessages(sessionId: string) {
  return [
    { id: `${sessionId}:1`, sessionId, senderIdentityId: 'human:me', senderRole: 'self', messageKind: 'text', contentText: 'which model are you using', content: { sender: 'Me', timeLabel: '10:00' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'cloud', sourceEventId: `${sessionId}:e1` },
    { id: `${sessionId}:2`, sessionId, senderIdentityId: 'agent:cloud-self', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'A reply', content: { sender: 'Kordi', timeLabel: '10:01' }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'cloud', sourceEventId: `${sessionId}:e2` },
  ];
}

const canonicalState = {
  storagePath: '/tmp/canonical.sqlite3',
  profile: { id: 'profile:me', displayName: 'Me', humanIdentityId: 'human:me', activeAgentIdentityId: 'agent:cloud-self', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
  identities: [
    { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
    { id: 'agent:cloud-self', kind: 'agent', displayName: 'Kordi', source: 'cloud', ownerIdentityId: 'human:me', avatarKey: 'agent', createdAtMs: 1, updatedAtMs: 1 },
  ],
  sessions: [canonicalSession(cloudChatId, 'which model are you using', 300), canonicalSession(localChatId, 'Saved local chat', 200)],
  participants: [cloudChatId, localChatId].flatMap((sessionId) => [
    { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    { sessionId, identityId: 'agent:cloud-self', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
  ]),
  messages: [...canonicalMessages(cloudChatId), ...canonicalMessages(localChatId)],
  delegatedExchanges: [],
  presence: [],
  contextSnapshots: [],
};

function runtimeSession(id: string, title: string) {
  return { id, title, subtitle: '', updatedAtLabel: '10:01', updatedAtMs: 2, messageCount: 2, draft: false, cwd: '/tmp/chat', messages: [] };
}

/** The runtime lists only the saved local chat; its active session moves on every refresh. */
export function desktopState(activeSessionId: string) {
  const active = activeSessionId === cloudChatId
    ? runtimeSession(cloudChatId, 'which model are you using')
    : runtimeSession(localChatId, 'Saved local chat');
  return { activeSessionId, activeSession: active, sessions: [runtimeSession(localChatId, 'Saved local chat')], projects: [], cwd: '/tmp/chat' } as unknown as DesktopChatState;
}

/** Mirrors the desktop entries useWorkspaceViewModels builds from the runtime state. */
function desktopEntries(state: DesktopChatState) {
  const { sessionSummaries, unlistedActiveSessionId } = localProjectSessions(state);
  return sessionSummaries.map((session) => ({
    id: session.id, canonicalSessionId: session.id, localSessionCwd: session.id === state.activeSession.id ? state.activeSession.cwd : null,
    desktopRuntimeBacked: true, desktopRuntimeUnlisted: session.id === unlistedActiveSessionId || undefined,
    desktopRuntimeTranscriptLoaded: true, name: session.title, type: 'owned-agent', subtitle: '', unread: 0,
    collaborationSources: ['Local'], trust: 'Owned', directness: 'Agent chat', participants: ['Me', 'Kordi'],
    messages: [{ role: 'user', sender: 'Me', text: 'which model are you using', time: '10:00' }], _updatedAtMs: session.updatedAtMs,
  }));
}

export function selectedFor(sessionId: string, state: DesktopChatState): Conversation {
  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const chatConversations = readModel.buildChatConversations(desktopEntries(state) as never, (messages, fallback) => messages[0]?.text ?? fallback ?? '');
  return activeConversationForSelection(sessionId, chatConversations, {
    isNativeShell: true,
    nativeChatPlaceholder: nativeChatPlaceholderForSelection(sessionId),
  });
}

// Opening the chat loads a runtime copy, a project catalog read drops it, and running the reply loads it again.
export const refreshes = [localChatId, cloudChatId, localChatId, cloudChatId, localChatId];

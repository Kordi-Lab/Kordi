import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { reusableBlankDesktopSessionId } from '../src/app/useKordiSideAgentSessionActions';
import { existingBlankSessionIdForParticipantSpace } from '../src/features/chat/chatCreateFlows';
import { isUnmaterializedDesktopAgentSession } from '../src/features/chat/draftSessions';
import {
  markOptimisticCanonicalMessageSent,
  sentPreparedCanonicalUserMessage,
} from '../src/features/chat/messageActions/canonicalDelivery';
import { prepareCanonicalUserMessage } from '../src/features/chat/messageActions/optimistic';
import {
  buildParticipantSpaces,
  collapseBlankConversationShells,
} from '../src/features/chat/participantSpaces';
import type {
  CanonicalSessionState,
  Conversation,
  ParticipantSpaceViewModel,
} from '../src/kordi-app/types';

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

type ConversationFixture = Conversation & { _updatedAtMs?: number };

function conversation(overrides: Partial<ConversationFixture> = {}): ConversationFixture {
  return {
    id: 'session:default',
    canonicalSessionId: 'session:default',
    name: 'New session',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Agent chat',
    participants: ['Me', 'My Kordi'],
    canonicalParticipants: [],
    canonicalMessageCount: 0,
    messages: [],
    ...overrides,
  };
}

test('accepted local Agent messages settle their optimistic canonical delivery state', () => {
  const prepared = prepareCanonicalUserMessage(
    'session-1', 'human:me', 'hello', [], '12:31', 'desktop-chat-ui',
  );
  const sent = sentPreparedCanonicalUserMessage(prepared);
  const state = {
    sessions: [{ id: 'session-1', updatedAtMs: 1, lastMessageAtMs: 1 }],
    messages: [{
      id: prepared?.messageId,
      sessionId: 'session-1',
      status: 'sending',
      updatedAtMs: 1,
      content: { sender: 'Me', timeLabel: '12:31' },
    }],
  } as unknown as CanonicalSessionState;
  const [message] = markOptimisticCanonicalMessageSent(
    state, 'session-1', prepared?.messageId,
  )?.messages ?? [];

  assert.equal(sent?.request.status, 'sent');
  assert.equal((sent?.request.content as { deliveryState?: string }).deliveryState, 'sent');
  assert.equal(message?.status, 'sent');
  assert.equal((message?.content as { deliveryState?: string }).deliveryState, 'sent');
});

test('Ask Agent reuses one idle blank side session but not the main or a busy session', () => {
  const state = {
    activeSessionId: 'session:main',
    activeSession: {
      id: 'session:main',
      title: 'Main conversation',
      messageCount: 2,
      draft: false,
      project: null,
      messages: [{ role: 'user', text: 'hello' }],
    },
    sessions: [
      { id: 'session:main', title: 'Main conversation', messageCount: 2, draft: false },
      { id: 'session:blank', title: 'New chat', messageCount: 0, draft: false },
    ],
  } as never;

  assert.equal(reusableBlankDesktopSessionId(state, 'session:main'), 'session:blank');
  assert.equal(
    reusableBlankDesktopSessionId(state, 'session:main', new Set(['session:blank'])),
    null,
  );
});

test('Ask Agent remains available without an existing agent session and authenticates before creating one', () => {
  const chatsPage = source('../src/pages/ChatsPage.tsx');
  const companionSession = source('../src/pages/useChatCompanionSession.ts');

  assert.match(companionSession, /canOpen: Boolean\(suggested \|\| onCreateAgentSession\)/);
  assert.match(companionSession, /if \(!suggested\) return create\(initialPrompt\)/);
  assert.match(
    chatsPage,
    /const openSideAgentPanel = async[\s\S]*if \(!auth\.hasAnyAuth\) \{[\s\S]*openAuthentication\(\);[\s\S]*return false;/,
  );
});

test('desktop startup distinguishes an unmaterialized shell from a real session', () => {
  assert.equal(isUnmaterializedDesktopAgentSession({
    title: 'New chat',
    messageCount: 0,
    draft: true,
    messages: [],
  }), true);
  assert.equal(isUnmaterializedDesktopAgentSession({
    title: 'Release plan',
    messageCount: 1,
    draft: false,
    messages: [{ role: 'user', text: 'Ship it' }],
  }), false);
});

test('participant-space continuation reuses a hidden persisted group blank', () => {
  const space = {
    kind: 'group',
    reusableBlankSessionId: 'session:group:hidden-empty-continuation',
    sessions: [],
  } as unknown as ParticipantSpaceViewModel;
  assert.equal(
    existingBlankSessionIdForParticipantSpace(space),
    'session:group:hidden-empty-continuation',
  );
});

test('group view models retain a hidden blank continuation as the reusable session', () => {
  const participants = [
    { id: 'human:me', name: 'Me', kind: 'human' as const, role: 'self' as const, source: 'local' as const },
    { id: 'human:alice', name: 'Alice', kind: 'human' as const, role: 'person' as const, source: 'bridge' as const },
    { id: 'human:bob', name: 'Bob', kind: 'human' as const, role: 'person' as const, source: 'bridge' as const },
  ];
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:root',
      canonicalSessionId: 'session:group:root',
      type: 'person',
      name: 'Team',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: participants,
      participantSpaceId: 'group:session:group:root',
      canonicalMessageCount: 1,
      messages: [{ role: 'person', sender: 'Alice', text: 'Hello', time: '10:00' }],
      metadata: { groupId: 'session:group:root', groupSpaceId: 'session:group:root' },
    }),
    conversation({
      id: 'session:group:hidden-empty',
      canonicalSessionId: 'session:group:hidden-empty',
      type: 'person',
      name: 'New chat',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: participants,
      participantSpaceId: 'group:session:group:root',
      metadata: { groupId: 'session:group:root', groupSpaceId: 'session:group:root' },
    }),
  ]);

  assert.deepEqual(spaces[0]?.sessions.map((session) => session.id), ['session:group:root']);
  assert.equal(spaces[0]?.reusableBlankSessionId, 'session:group:hidden-empty');
});

test('blank-agent deduplication keeps a message-free chat while its first turn runs', () => {
  const running = conversation({
    id: 'session:self-agent:running',
    canonicalSessionId: 'session:self-agent:running',
    previewLiveTurn: {
      id: 'turn:running',
      sessionId: 'session:self-agent:running',
      prompt: 'Hello',
      status: 'running',
      message: '',
      assistantText: '',
      thinkingText: '',
      tools: [],
      completed: false,
      succeeded: false,
    },
  });
  const newerBlank = conversation({
    id: 'session:self-agent:newer-blank',
    canonicalSessionId: 'session:self-agent:newer-blank',
    _updatedAtMs: 2,
  });
  const olderBlank = conversation({
    id: 'session:self-agent:older-blank',
    canonicalSessionId: 'session:self-agent:older-blank',
    _updatedAtMs: 1,
  });

  assert.deepEqual(
    collapseBlankConversationShells([running, newerBlank, olderBlank]).map(({ id }) => id),
    ['session:self-agent:running', 'session:self-agent:newer-blank'],
  );
});

test('side Agent sends stay optimistic while materializing the target runtime', () => {
  const chatMessages = source('../src/features/chat/messageActions/chatMessages.ts');
  const materializer = source('../src/features/chat/messageActions/localAgentSessionTarget.ts');
  const targetedStart = chatMessages.indexOf('const sendTargetedChatMessage = useCallback');
  const targetedBlock = chatMessages.slice(
    targetedStart,
    chatMessages.indexOf('const handleSendChatMessage = useCallback', targetedStart),
  );
  const sharedSendStart = chatMessages.indexOf('const sendLocalAgentChatMessage = useCallback');
  const sharedSendBlock = chatMessages.slice(sharedSendStart, targetedStart);

  assert.match(
    targetedBlock,
    /await sendLocalAgentChatMessage\(\{[\s\S]*materializeTarget: \(\) => materializeLocalChatTarget\(targetConversation\.id\)/,
  );
  assert.doesNotMatch(targetedBlock, /await materializeLocalChatTarget\(targetConversation\.id\)/);
  assert.ok(
    sharedSendBlock.indexOf('setCanonicalSessionState((current) => appendOptimisticCanonicalMessage')
      < sharedSendBlock.indexOf('await materializeTarget()'),
    'the visible user turn must be committed before background runtime loading can delay or fail',
  );
  assert.match(
    sharedSendBlock,
    /if \(materializeTarget\) resolvedMaterializedState = await materializeTarget\(\);[\s\S]*appendOptimisticOutboundMessage/,
  );
  assert.match(materializer, /await fetchDesktopChatState\(sessionId\)/);
  assert.match(materializer, /materializedState\.activeSessionId !== sessionId[\s\S]*materializedState\.activeSession\.id !== sessionId/);
  assert.match(chatMessages, /if \(materializedState\) setDesktopChatState\(materializedState\)/);
});

test('opening Ask Agent reports and renders authoritative transcript hydration', () => {
  const chatsPage = source('../src/pages/ChatsPage.tsx');
  const companionSession = source('../src/pages/useChatCompanionSession.ts');
  const shellBuilder = source('../src/app/mainContentShellBuilders.ts');
  const sessionController = source('../src/features/chat/useDesktopSessionController.ts');
  const companionWorkspace = source('../src/pages/chatsPage.companionWorkspace.tsx');
  const companionPane = source('../src/pages/chatsPage.companionPane.tsx');
  const transcriptCache = source('../src/features/chat/useDesktopSessionTranscriptCache.ts');
  const workspaceViewModels = source('../src/app/useWorkspaceViewModels.ts');

  assert.match(shellBuilder, /onPrefetchChatSession: args\.handlePrefetchChatSession/);
  assert.match(chatsPage, /onPrefetchChatSession,?[\s\S]*useChatCompanionSession\(\{[\s\S]*onPrefetchChatSession,/);
  assert.match(sessionController, /return await preloadDesktopSessionTranscript\(sessionId\)/);
  assert.match(companionSession, /desktopRuntimeTranscriptLoaded !== true/);
  assert.match(companionSession, /onPrefetchChatSession\(conversationId\)\.then\(\(loaded\)/);
  assert.match(companionSession, /Couldn’t load chat history\./);
  assert.doesNotMatch(companionSession, /onPrefetchChatSession\??\.\(activeConversation\.id\)/);
  assert.match(companionWorkspace, /session\.transcript\.isLoading[\s\S]*transcriptLoadingNotice\(\)/);
  assert.match(companionWorkspace, /session\.transcript\.loadError[\s\S]*Try again/);
  assert.match(companionPane, /aria-busy=\{messagesLoading \|\| undefined\}/);
  assert.match(transcriptCache, /hydratedSessionIdsRef\.current\.has\(normalizedSessionId\)/);
  assert.doesNotMatch(transcriptCache, /if \(sourceCacheRef\.current\[normalizedSessionId\]\) return Promise\.resolve\(true\)/);
  assert.match(workspaceViewModels, /desktopRuntimeTranscriptLoaded: hydratedDesktopSessionIds\.has\(session\.id\)/);
});

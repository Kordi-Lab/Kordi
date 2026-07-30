import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useWorkspaceViewModels } from '../src/app/useWorkspaceViewModels';
import { shouldUseCanonicalMessages } from '../src/features/canonical/readModel/conversationMapping';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { mergeCanonicalHistoryIntoRuntime } from '../src/features/canonical/sessionReadModel';
import type { Message } from '../src/kordi-app/types';

test('workspace sorts a newly active local session ahead of older canonical sessions', () => {
  const activeSessionId = 'local-newly-active';
  const olderSessionId = 'local-older-canonical';
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;

  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: {
        cwd: '/tmp/kordi',
        activeSessionId,
        sessions: [{
          id: olderSessionId,
          title: 'Older session',
          subtitle: 'Older activity',
          updatedAtLabel: 'Jul 15',
          updatedAtMs: 1_000,
          messageCount: 1,
          draft: false,
        }],
        activeSession: {
          id: activeSessionId,
          cwd: '/tmp/kordi',
          title: 'Newly active session',
          subtitle: 'Just sent',
          provider: 'openai',
          providerLabel: 'OpenAI',
          model: 'gpt-test',
          modelLabel: 'GPT Test',
          thinking: 'medium',
          thinkingLabel: 'Medium',
          thinkingLevels: ['medium'],
          updatedAtLabel: '15:59',
          updatedAtMs: 9_000,
          messageCount: 1,
          draft: false,
          contextWindowText: '',
          contextWindowStatus: {
            contextWindow: 0,
            usedTokens: null,
            usedPercent: null,
            autoCompaction: false,
          },
          project: null,
          reflectionLessonArtifacts: [],
          messages: [{
            role: 'user',
            text: 'new activity',
            timeLabel: '15:59',
            timestampMs: 9_000,
          }],
        },
        localAgent: {
          label: 'My Kordi',
          systemPrompt: '',
          loadedSkills: [],
          loadedTools: [],
          loadedPlugins: [],
          identityFiles: [],
          defaultProvider: 'openai',
          defaultModel: 'gpt-test',
          workspaceRoot: '/tmp/kordi',
          lastActivities: [],
        },
        projects: [],
        modelOptions: [],
        slashCommands: [],
      } as never,
      desktopBridgeState: null,
      canonicalSessionState: {
        storagePath: '/tmp/canonical.sqlite3',
        profile: {
          id: 'profile:me',
          displayName: 'Me',
          humanIdentityId: 'human:me',
          activeAgentIdentityId: 'agent:me',
          storageRoot: '/tmp',
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        identities: [
          { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
          { id: 'agent:me', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-me', createdAtMs: 1, updatedAtMs: 1 },
        ],
        sessions: [{
          id: olderSessionId,
          kind: 'self-agent',
          title: 'Older session',
          status: 'active',
          createdByIdentityId: 'human:me',
          primaryIdentityId: 'agent:me',
          relationshipIdentityId: 'agent:me',
          metadata: { source: 'desktop-chat' },
          createdAtMs: 500,
          updatedAtMs: 1_000,
          lastMessageAtMs: 1_000,
        }],
        participants: [
          { sessionId: olderSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 500 },
          { sessionId: olderSessionId, identityId: 'agent:me', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 500 },
        ],
        messages: [],
        delegatedExchanges: [],
        contextSnapshots: [],
        presence: [],
      },
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: activeSessionId,
      activeProjectId: '',
      activeProjectSessionId: 'draft:project-chat',
      chatSearch: '',
      projectSearch: '',
      contactSearch: '',
      activeContactId: '',
      activeAgentId: '',
      cachedChatSessionMessages: {},
      cachedProjectSessionMessages: {},
      localSessionUnreadCounts: {},
      desktopLiveTurnsBySession: {},
      mapDesktopMessages: (_sessionId, messages) => messages.map((message) => ({
        role: message.role === 'assistant' ? 'owned-agent' : 'user',
        text: message.text,
        time: message.timeLabel,
      })),
    });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  assert.deepEqual(
    viewModels?.chatConversations.slice(0, 2).map((conversation) => conversation.id),
    [activeSessionId, olderSessionId],
  );
  assert.equal(viewModels?.activeConv.id, activeSessionId);
});

test('runtime transcript reconciliation renders one failure when canonical and desktop rows encode it differently', () => {
  const failure = 'ChatGPT OAuth credentials are not usable. Sign in to ChatGPT again, or switch this provider to an OpenAI API key.';
  const canonicalFailure: Message = {
    id: 'canonical-provider-failure',
    role: 'owned-agent',
    text: '',
    time: '17:30',
    turn: {
      id: 'canonical-turn:provider-failure',
      sessionId: 'session:test',
      prompt: '',
      status: 'complete',
      message: 'Complete',
      assistantText: failure,
      thinkingText: '',
      tools: [],
      completed: true,
      succeeded: true,
      error: null,
    },
  };
  const runtimeFailure: Message = {
    id: 'runtime-provider-failure',
    role: 'owned-agent',
    text: failure,
    time: '17:30',
    turn: {
      id: 'runtime-turn:provider-failure',
      sessionId: 'session:test',
      prompt: '',
      status: 'failed',
      message: 'Request failed',
      assistantText: '',
      thinkingText: '',
      tools: [],
      completed: true,
      succeeded: false,
      error: failure,
    },
  };

  const merged = mergeCanonicalHistoryIntoRuntime([canonicalFailure], [runtimeFailure]);

  assert.deepEqual(merged.map((message) => message.id), ['runtime-provider-failure']);
  assert.equal(shouldUseCanonicalMessages([runtimeFailure], [canonicalFailure]), false);
});

test('desktop entry aliases reconcile tool-only canonical and runtime turns after returning to a parent fork', () => {
  const identities = new Map([
    ['human:me', {
      id: 'human:me',
      kind: 'human',
      displayName: 'Me',
      source: 'local',
      avatarKey: 'human:me',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    ['agent:me', {
      id: 'agent:me',
      kind: 'agent',
      displayName: 'Kordi',
      ownerIdentityId: 'human:me',
      source: 'local',
      avatarKey: 'agent:me',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
  ]);
  const canonicalMessage = mapCanonicalMessage({
    id: 'msg:canonical-tool-turn',
    sessionId: 'session:parent',
    senderIdentityId: 'agent:me',
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      desktopEntryId: 'entry:runtime-tool-turn',
      thinkingText: 'Inspecting the issue',
      timeLabel: '16:05',
      tools: [{
        id: 'tool:edit',
        name: 'edit',
        status: 'error',
        arguments: '{}',
        liveOutput: '',
        isError: true,
      }],
    },
    status: 'complete',
    sequenceNum: 6,
    createdAtMs: 6,
    updatedAtMs: 6,
    sourceTransport: 'desktop-chat',
  }, identities, 'human:me');
  assert.ok(canonicalMessage);
  assert.equal(canonicalMessage.entryId, 'entry:runtime-tool-turn');

  const runtimeMessage: Message = {
    id: 'desktop-message:session:parent:6:owned-agent',
    entryId: 'entry:runtime-tool-turn',
    role: 'owned-agent',
    sender: 'My Kordi',
    text: '',
    time: '16:05',
    turn: {
      id: 'runtime-tool-turn',
      sessionId: 'session:parent',
      prompt: '',
      status: 'succeeded',
      message: 'Response complete',
      assistantText: '',
      thinkingText: 'Inspecting the issue',
      tools: [{
        id: 'tool:edit',
        name: 'edit',
        status: 'error',
        arguments: '{}',
        liveOutput: '',
        isError: true,
      }],
      completed: true,
      succeeded: false,
      error: null,
    },
  };

  const merged = mergeCanonicalHistoryIntoRuntime([canonicalMessage], [runtimeMessage]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, runtimeMessage.id);
  assert.deepEqual(merged[0]?.replyAliasIds, [
    'msg:canonical-tool-turn',
    'entry:runtime-tool-turn',
  ]);

  const forkSnapshot = mapCanonicalMessage({
    id: 'msg:fork-snapshot-tool-turn',
    sessionId: 'session:fork',
    senderIdentityId: 'agent:me',
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      desktopEntryId: 'entry:runtime-tool-turn',
      timeLabel: '16:05',
    },
    status: 'complete',
    sequenceNum: 1,
    createdAtMs: 6,
    updatedAtMs: 6,
    sourceTransport: 'canonical-fork-snapshot',
  }, identities, 'human:me');
  assert.equal(forkSnapshot?.entryId, 'msg:fork-snapshot-tool-turn');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { Conversation } from '../src/kordi-app/types';
import { chatCompanionSessionOptions } from '../src/pages/chatsPage.model';

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'conversation',
    name: 'Conversation',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: [],
    trust: 'Trusted',
    directness: 'Direct',
    participants: [],
    messages: [],
    ...overrides,
  };
}

test('side chat picker retains an Agent session whose parent is a group conversation', () => {
  const group = conversation({ id: 'session:group:source', type: 'person' });
  const agent = conversation({ id: 'research-session', forkedFromSessionId: group.id });
  const options = chatCompanionSessionOptions(group, [group, agent]);
  assert.equal(options.length, 1);
  assert.equal(options[0].conversation.id, agent.id);
  assert.equal(options[0].depth, 0);
  assert.equal(options[0].conversation.forkedFromSessionId, group.id);
});

test('side chat session options keep the main Agent hierarchy and renamed title', () => {
  const activeMainSession = conversation({
    id: 'main-session',
    canonicalSessionId: 'session:main',
    name: 'hahahxhat',
    _updatedAtMs: 100,
  });
  const rootSession = conversation({
    id: 'root-session',
    canonicalSessionId: 'session:root',
    name: 'Model and identity',
    _updatedAtMs: 400,
  });
  const childSession = conversation({
    id: 'child-session',
    canonicalSessionId: 'session:child',
    name: 'New chat',
    forkedFromSessionId: 'session:root',
    _updatedAtMs: 300,
  });
  const grandchildSession = conversation({
    id: 'grandchild-session',
    canonicalSessionId: 'session:grandchild',
    name: 'New chat',
    forkedFromSessionId: 'child-session',
    _updatedAtMs: 200,
  });

  assert.deepEqual(
    chatCompanionSessionOptions(activeMainSession, [
      grandchildSession,
      activeMainSession,
      childSession,
      rootSession,
    ]).map((option) => ({
      id: option.conversation.id,
      name: option.conversation.name,
      depth: option.depth,
      openInMain: option.openInMain,
      selectable: option.selectable,
    })),
    [
      {
        id: 'root-session',
        name: 'Model and identity',
        depth: 0,
        openInMain: false,
        selectable: true,
      },
      {
        id: 'child-session',
        name: 'New chat',
        depth: 1,
        openInMain: false,
        selectable: true,
      },
      {
        id: 'grandchild-session',
        name: 'New chat',
        depth: 2,
        openInMain: false,
        selectable: true,
      },
      {
        id: 'main-session',
        name: 'hahahxhat',
        depth: 0,
        openInMain: true,
        selectable: false,
      },
    ],
  );
});

test('side chat picker exposes hierarchy, panel states, and flat inactive rows', () => {
  const headerSource = readFileSync(
    new URL('../src/pages/chatsPage.companionHeader.tsx', import.meta.url),
    'utf8',
  );
  const sessionSource = readFileSync(
    new URL('../src/pages/useChatCompanionSession.ts', import.meta.url),
    'utf8',
  );

  assert.match(headerSource, /data-side-chat-session-option="true"/);
  assert.match(headerSource, /data-side-chat-open-in-main=/);
  assert.match(headerSource, /data-side-chat-current-session=/);
  assert.match(headerSource, /data-session-fork-depth=/);
  assert.match(headerSource, /app-transient-scroll/);
  assert.match(headerSource, /app-transient-row app-transient-flat-action app-transient-action-row mb-1/);
  assert.match(headerSource, /!isCurrent && 'app-transient-flat-action'/);
  assert.match(headerSource, />\s*Main\s*</);
  assert.match(headerSource, />\s*Current\s*</);
  assert.match(sessionSource, /candidateIds\.has\(conversationId\)/);
  assert.match(sessionSource, /selectableSessionIds\.has\(conversationId\)/);
});

test('related agent sessions open in the companion panel instead of replacing main chat', () => {
  const pageSource = readFileSync(
    new URL('../src/pages/ChatsPage.tsx', import.meta.url),
    'utf8',
  );
  const mainSource = readFileSync(
    new URL('../src/pages/chatsPage.mainWorkspace.tsx', import.meta.url),
    'utf8',
  );
  const companionSource = readFileSync(
    new URL('../src/pages/chatsPage.companionWorkspace.tsx', import.meta.url),
    'utf8',
  );
  const sessionSource = readFileSync(
    new URL('../src/pages/useChatCompanionSession.ts', import.meta.url),
    'utf8',
  );
  const workspaceSource = readFileSync(
    new URL('../src/app/useWorkspaceViewModels.ts', import.meta.url),
    'utf8',
  );
  const backgroundSessionSource = readFileSync(
    new URL('../src/app/viewModels/backgroundSessions.ts', import.meta.url),
    'utf8',
  );
  const controllerSource = readFileSync(
    new URL('../src/features/chat/useDesktopSessionController.ts', import.meta.url),
    'utf8',
  );

  assert.match(pageSource, /companionSession\.actions\.switchConversation\(sessionId\)/);
  assert.match(pageSource, /directConversations: companionConversations/);
  assert.match(pageSource, /companionLayout\.placeCompanion\('right'\)/);
  assert.match(pageSource, /companionLayout\.setFolded\(false\)/);
  assert.match(sessionSource, /chatCompanionCandidates\(activeConversation, directConversations\)/);
  assert.match(sessionSource, /chatCompanionSessionOptions\(activeConversation, conversations\)/);
  assert.match(sessionSource, /requestedConversationId: conversationId/);
  assert.match(sessionSource, /onPrefetchChatSession\(conversationId\)/);
  assert.match(sessionSource, /candidateIds\.has\(state\.requestedConversationId\)/);
  assert.match(controllerSource, /loaded && !isKnownSession[\s\S]*refreshDesktopChat\(\)/);
  assert.match(workspaceSource, /companionConversationList\(chatConversations/);
  assert.match(backgroundSessionSource, /return chatConversations/);
  assert.match(mainSource, /onOpenForkSession: companion\.openSession/);
  assert.match(companionSource, /onOpenForkSession: shell\.openSession/);
  assert.match(pageSource, /companionSession\.actions\.openSubsession\(sessionId\)/);
  const linksSource = readFileSync(new URL('../src/kordi-app/components/relatedAgentSessionLinks.tsx', import.meta.url), 'utf8');
  const transcriptSource = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(linksSource, /AgentSubsessionDialog|AppDialog|setSelected/);
  assert.match(transcriptSource, /<RelatedAgentSessionLinks[\s\S]*?onOpen=\{onOpenForkSession\}/);
  assert.doesNotMatch(mainSource, /onOpenForkSession: runtime\.onSelectSession/);
});

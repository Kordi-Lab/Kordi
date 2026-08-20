import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentSessionKind,
  agentSessionParticipantSpaceKind,
} from '../src/features/chat/agentSessionRouting';
import {
  buildChatAgentSessionMetadata,
} from '../src/features/chat/chatCreateFlows';
import { publishedAgentRuntimeRouteFromConversation } from '../src/features/chat/agentSessionRuntimeRoute';
import { localOwnedAgentSessionsForCloudHiding } from '../src/features/cloud/useCloudCollaborationReadModel';
import { agent } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('only default Kordi uses the generic self-agent session path', () => {
  const defaultKordi = agent({ id: 'desktop:local-agent', isOwned: true });
  const customAgent = agent({ id: 'agent:reviewer', isOwned: true });

  assert.equal(agentSessionKind(defaultKordi), 'self-agent');
  assert.equal(agentSessionParticipantSpaceKind(defaultKordi), 'self');
  assert.equal(agentSessionKind(customAgent), 'direct-agent');
  assert.equal(agentSessionParticipantSpaceKind(customAgent), 'direct-agent');
});

test('the owner Mac keeps published custom agents on the local direct runtime', () => {
  const sessions = [
    { id: 'default', kind: 'self-agent', metadata: null },
    { id: 'published', kind: 'direct-agent', metadata: { createdFrom: 'chat-create-flow' } },
    { id: 'remote', kind: 'direct-agent', metadata: { createdFrom: 'cloud' } },
  ] as never;

  assert.deepEqual(
    localOwnedAgentSessionsForCloudHiding(sessions).map((session) => session.id),
    ['default', 'published'],
  );
});

test('published custom agent sessions carry their tested runtime route', () => {
  const customAgent = agent({
    id: 'cloud-agent:stock',
    cloudAgentId: 'cloud_agent_stock',
    isOwned: true,
    defaultModel: 'openai/gpt-5.6-sol',
    defaultAuthProvider: 'openai',
    defaultAuthChoice: 'chatgpt-account',
    defaultThinking: 'medium',
  });
  const metadata = buildChatAgentSessionMetadata(customAgent);

  assert.deepEqual(publishedAgentRuntimeRouteFromConversation({ metadata }), {
    model: 'openai/gpt-5.6-sol',
    authProvider: 'openai',
    authChoice: 'chatgpt-account',
    thinking: 'medium',
  });
});

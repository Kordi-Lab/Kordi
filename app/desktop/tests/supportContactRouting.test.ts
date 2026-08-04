import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeConversationForSelection,
  pendingCloudCollaborationConversationForActiveId,
} from '../src/app/viewModels/conversationSelection';
import { resolveDirectHostedAgentTarget } from '../src/features/chat/messageActions/directHostedAgentTarget';
import type { Conversation } from '../src/kordi-app/types';
import { KORDI_SUPPORT_AVATAR_URL } from '../src/features/support/supportIdentity';

function supportConversation(): Conversation {
  return {
    id: 'cloud:conversation:acct_kordi_support:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support',
    canonicalSessionId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    name: 'Kordi Support',
    type: 'person',
    subtitle: 'Ask questions or suggest improvements',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Cloud',
    directness: 'Person chat',
    participants: ['Me', 'Kordi Support'],
    messages: [],
    supportTicketEnabled: true,
    collaborationTarget: {
      hostId: 'cloud',
      nodeId: 'acct_kordi_support',
      displayName: 'Kordi Support',
      ownerName: 'Kordi',
      runtime: 'kordi-desktop',
      humanId: 'acct_kordi_support',
      agentId: 'cloud_agent_kordi_support',
    },
  };
}

test('legacy unscoped support selection resolves to the named support session', () => {
  const conversation = supportConversation();
  const selected = activeConversationForSelection(
    'cloud:conversation:acct_kordi_support:agent',
    [conversation],
    { isNativeShell: true, nativeChatPlaceholder: conversation },
  );

  assert.equal(selected.id, conversation.id);
  assert.equal(selected.name, 'Kordi Support');
});

test('legacy pending support selection preserves its product identity and direct route', () => {
  const conversation = pendingCloudCollaborationConversationForActiveId(
    'cloud:conversation:acct_kordi_support:agent',
  );

  assert.equal(conversation?.name, 'Kordi Support');
  assert.equal(conversation?.subtitle, 'Ask questions or suggest improvements');
  assert.equal(conversation?.type, 'person');
  assert.equal(conversation?.directness, 'Person chat');
  assert.equal(conversation?.supportTicketEnabled, true);
  assert.equal(conversation?.profileImageUrl, KORDI_SUPPORT_AVATAR_URL);
  assert.equal(conversation?.collaborationTarget?.runtime, 'kordi-desktop');
  assert.equal(conversation?.collaborationTarget?.agentId, 'cloud_agent_kordi_support');
  assert.deepEqual(resolveDirectHostedAgentTarget({
    mentionedAgentId: null,
    mentionedTarget: null,
    activeTarget: conversation?.collaborationTarget,
  }), {
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_kordi_support',
    targetCloudAgentOwnerName: 'Kordi',
  });
});

test('scoped pending support selection recovers the support target from its session id', () => {
  const conversation = pendingCloudCollaborationConversationForActiveId(
    'cloud:conversation:acct_support_owner:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support',
  );

  assert.equal(conversation?.name, 'Kordi Support');
  assert.equal(conversation?.supportTicketEnabled, true);
  assert.equal(conversation?.collaborationTarget?.nodeId, 'acct_support_owner');
  assert.equal(conversation?.collaborationTarget?.agentId, 'cloud_agent_kordi_support');
});

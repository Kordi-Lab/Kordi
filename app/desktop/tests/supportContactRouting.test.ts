import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeConversationForSelection,
  pendingCloudCollaborationConversationForActiveId,
} from '../src/app/viewModels/conversationSelection';
import type { Conversation } from '../src/kordi-app/types';

function supportConversation(): Conversation {
  return {
    id: 'cloud:conversation:acct_kordi_support:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support',
    canonicalSessionId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    name: 'Kordi Support',
    type: 'external-agent',
    subtitle: 'Ask questions or suggest improvements',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Cloud',
    directness: 'Agent chat',
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

test('pending Cloud agent selection never exposes its backing account id as a title', () => {
  const conversation = pendingCloudCollaborationConversationForActiveId(
    'cloud:conversation:acct_kordi_support:agent',
  );

  assert.equal(conversation?.name, 'Opening agent chat…');
  assert.notEqual(conversation?.name, 'acct_kordi_support');
  assert.equal(conversation?.collaborationTarget?.runtime, 'kordi-desktop');
});

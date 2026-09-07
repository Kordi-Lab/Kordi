import assert from 'node:assert/strict';
import test from 'node:test';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { buildCloudCollaborationConversation } from '../src/features/cloud/cloudCollaborationState';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { encodeCloudAgentCancel } from '../src/features/cloud/cloudAgentMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { cloudAccountAvatarFixture as avatar } from './helpers/cloudAccountAvatarFixture';

const accounts: CloudAccount[] = ['Owner', 'Peer'].map((name) => ({
  accountId: name, displayName: name, primaryEmail: `${name}@example.test`,
  avatarUrl: null, avatar, nodeId: name, passwordSet: true,
  defaultAgent: { agentId: `cloud-agent:${name}`, displayName: `${name} Assistant`, avatarUrl: null, avatar },
}));

test('a cancelled Agent request keeps its target identity from both contact-chat perspectives', () => {
  for (const targetName of ['Owner Assistant', 'Custom Researcher']) {
    for (const canceller of accounts) {
      const request: CloudMessage = {
        messageId: 'request', fromAccountId: 'Owner', toAccountId: 'Peer',
        createdAt: '2026-09-06T10:00:00Z', direction: 'outgoing', deliveredAt: null, readAt: null,
        body: encodeCloudDirectMessageEnvelope({
          schemaVersion: 1, kind: 'message', text: '@OwnerAssistant hi',
          targetCloudAgentId: targetName === 'Owner Assistant' ? 'cloud-agent:Owner' : 'cloud_agent_researcher',
          targetCloudAgentName: targetName, targetCloudAgentOwnerAccountId: 'Owner',
          targetCloudAgentOwnerName: 'Owner',
        }),
      };
      const cancel: CloudMessage = {
        ...request, messageId: 'cancel', fromAccountId: canceller.accountId,
        toAccountId: canceller.accountId === 'Owner' ? 'Peer' : 'Owner',
        createdAt: '2026-09-06T10:01:00Z', body: encodeCloudAgentCancel({ requestId: 'request' }),
      };
      for (const account of accounts) {
        const other = accounts.find((candidate) => candidate !== account)!;
        const contact = cloudContactToContact({ ...other, createdAt: request.createdAt });
        const conversation = buildCloudCollaborationConversation({ account, contact, messages: [request, cancel], runtime: 'person' });
        assert.equal(conversation.identity?.localAgentId, account.defaultAgent?.agentId);
        assert.equal(conversation.identity?.localAgentName, account.defaultAgent?.displayName);
        const view = mapCollaborationConversationToViewModel(conversation, undefined, 'Kordi');
        const response = view.messages.find((message) => message.turn?.status === 'cancelled');
        assert.ok(response);
        assert.equal(response.sender, targetName);
        assert.equal(response.role, account.accountId === 'Owner' ? 'owned-agent' : 'external-agent');
        assert.equal(response.senderOwnerName ?? (response.role === 'owned-agent' ? 'You' : null), account.accountId === 'Owner' ? 'You' : 'Owner');
        assert.equal(response.replyToMessageId, view.messages[0]?.id);
      }
    }
  }
});

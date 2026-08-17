import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Conversation, Message } from '../src/kordi-app/types';
import { transcriptHumanParticipant } from '../src/pages/chatSenderProfileModel';

const directConversation: Conversation = {
  id: 'session:one',
  canonicalSessionId: 'session:one',
  name: 'Maya Chen',
  type: 'person',
  subtitle: 'Direct chat',
  unread: 0,
  collaborationSources: ['Cloud'],
  trust: 'Owned',
  directness: 'Direct chat',
  participants: ['Maya Chen'],
  messages: [],
};

test('transcript sender profile resolves a direct contact before canonical participants hydrate', () => {
  const message: Message = {
    role: 'person',
    sender: 'Maya Chen',
    senderType: 'human',
    senderAvatarSeed: 'acct_maya',
    senderProfileImageUrl: 'https://example.com/maya.png',
    text: 'Hello',
    time: '10:42',
  };
  const conversation: Conversation = {
    ...directConversation,
    canonicalParticipants: undefined,
    collaborationTarget: {
      hostId: 'cloud',
      nodeId: 'acct_maya',
      humanId: 'acct_maya',
      ownerName: 'Maya Chen',
    },
  };

  assert.deepEqual(transcriptHumanParticipant(conversation, message), {
    id: 'human:acct_maya',
    humanId: 'acct_maya',
    sourceIdentityId: 'acct_maya',
    sourceHostId: 'cloud',
    name: 'Maya Chen',
    kind: 'human',
    role: 'person',
    source: 'cloud',
    avatarKey: 'acct_maya',
    profileImageUrl: 'https://example.com/maya.png',
  });
});

test('transcript sender profile never synthesizes a group member from the group target', () => {
  const message: Message = {
    role: 'person',
    sender: 'Maya Chen',
    senderType: 'human',
    text: 'Hello',
    time: '10:42',
  };

  assert.equal(transcriptHumanParticipant({
    ...directConversation,
    canonicalSessionId: 'session:group:release',
    directness: 'Group chat',
    canonicalParticipants: undefined,
    collaborationTarget: {
      hostId: 'cloud',
      nodeId: 'acct_group_owner',
      humanId: 'acct_group_owner',
    },
  }, message), null);
});

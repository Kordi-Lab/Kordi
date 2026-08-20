import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { loadCloudMessagesByPeerUntilStable } from '../src/features/cloud/cloudMessageSyncState';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: null,
};

test('cloud initial message sync follows group peer discovery until stable', async () => {
  const makeGroupMessage = (peer: string, discoveredPeer: string): CloudMessage => ({
    messageId: `msg_${peer}_${discoveredPeer}`,
    fromAccountId: peer,
    toAccountId: account.accountId,
    body: encodeCloudGroupControl({
      kind: 'group-message',
      groupId: `group_${peer}_${discoveredPeer}`,
      sessionId: `session_${peer}_${discoveredPeer}`,
      createdByAccountId: peer,
      actor: { accountId: peer, displayName: peer, avatarUrl: null },
      participants: [
        { accountId: account.accountId, displayName: 'Me Cloud', avatarUrl: null },
        { accountId: peer, displayName: peer, avatarUrl: null },
        { accountId: discoveredPeer, displayName: discoveredPeer, avatarUrl: null },
      ],
      message: {
        id: `group_msg_${peer}_${discoveredPeer}`,
        senderAccountId: peer,
        text: `hello ${discoveredPeer}`,
        createdAt: '2026-05-13T10:00:00Z',
      },
    }),
    createdAt: '2026-05-13T10:00:00Z',
    deliveredAt: '2026-05-13T10:00:00Z',
    readAt: null,
    direction: 'incoming',
  });

  const messagesByPeer: Record<string, CloudMessage[]> = {
    acct_peer_1: [makeGroupMessage('acct_peer_1', 'acct_peer_2')],
    acct_peer_2: [makeGroupMessage('acct_peer_2', 'acct_peer_3')],
    acct_peer_3: [makeGroupMessage('acct_peer_3', 'acct_peer_4')],
    acct_peer_4: [makeGroupMessage('acct_peer_4', 'acct_peer_5')],
    acct_peer_5: [],
  };

  const result = await loadCloudMessagesByPeerUntilStable({
    accountId: account.accountId,
    initialPeerIds: ['acct_peer_1'],
    existingMessagesByPeer: {},
    listMessages: async (peerId) => messagesByPeer[peerId] ?? [],
  });

  assert.equal(result.complete, true);
  assert.deepEqual(Object.keys(result.messagesByPeer).sort(), [
    'acct_peer_1',
    'acct_peer_2',
    'acct_peer_3',
    'acct_peer_4',
    'acct_peer_5',
  ]);
});

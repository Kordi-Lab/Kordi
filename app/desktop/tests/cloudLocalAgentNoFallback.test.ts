import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudFallbackRunClaimsForMessages } from '../src/features/cloud/cloudAgentFallbackClaims';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

test('locally executed published agent history never creates a Cloud fallback run', () => {
  const nowMs = Date.now();
  const account: CloudAccount = {
    accountId: 'acct_me',
    displayName: 'Me',
    primaryEmail: 'me@example.com',
    avatarUrl: null,
    avatar: cloudAccountAvatarFixture,
    nodeId: 'node_me',
    passwordSet: true,
  };
  const request: CloudMessage = {
    messageId: 'msg_local_direct_agent_history',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'already running locally',
    direction: 'outgoing',
    sessionId: 'session:direct-agent:stock',
    messageKind: 'canonical-history-user',
    createdAt: new Date(nowMs - 130_000).toISOString(),
    deliveredAt: null,
    readAt: null,
  };

  assert.deepEqual(cloudFallbackRunClaimsForMessages({
    account,
    contacts: [],
    messagesByPeer: { [account.accountId]: [request] },
    selfAgentFallbackBeforeMs: nowMs - 120_000,
  }), []);
});

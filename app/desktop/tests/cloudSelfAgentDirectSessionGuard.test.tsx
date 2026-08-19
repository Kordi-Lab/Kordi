import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/useCloudCollaborationState';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: 'node_me',
  passwordSet: true,
};

function emptyCanonicalState(): CanonicalSessionState {
  return {
    sessions: [],
    identities: [],
    participants: [],
    profile: {
      id: 'profile',
      storageRoot: '/tmp',
      humanIdentityId: 'human:acct_me',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;
}

test('cloud self-agent canonical sync ignores stranded direct-person scheduled responses', () => {
  const strandedScheduledResponse: CloudMessage = {
    messageId: 'cloudrunmsg_stranded_direct_response',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: encodeCloudAgentResponse({
      requestId: 'scheduled_run_stranded_direct',
      text: 'This should stay in the contact chat.',
    }),
    createdAt: '2026-06-26T09:35:14.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'session:direct-person:acct_me:acct_peer',
  };

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [strandedScheduledResponse],
    state: emptyCanonicalState(),
  });

  assert.deepEqual(plan.sessionRequests, []);
  assert.deepEqual(plan.messageRequests, []);
});

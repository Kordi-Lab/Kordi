import assert from 'node:assert/strict';
import test from 'node:test';

import { cloudGroupSessionPreparationSignature } from '../src/features/cloud/cloudGroupSessionControl';
import type { CloudAccount } from '../src/features/cloud/authClient';
import type { CloudGroupControlEnvelope } from '../src/features/cloud/cloudGroupMessages';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me',
  primaryEmail: 'me@example.test',
  avatarUrl: null,
  nodeId: 'node_me',
  passwordSet: true,
};

function groupMessage(overrides: Partial<CloudGroupControlEnvelope> = {}): CloudGroupControlEnvelope {
  return {
    kind: 'group-message',
    groupId: 'session:group:main',
    groupSpaceId: 'group:space',
    groupTitle: 'Research group',
    createdByAccountId: 'acct_me',
    actor: {
      accountId: 'acct_peer',
      displayName: 'Peer',
      avatarUrl: null,
      role: 'person',
    },
    participants: [
      {
        accountId: 'acct_me',
        displayName: 'Me',
        avatarUrl: null,
        role: 'self',
      },
      {
        accountId: 'acct_peer',
        displayName: 'Peer',
        avatarUrl: null,
        role: 'person',
      },
    ],
    sessionTitle: {
      title: 'main',
      titleSource: 'manual',
      titleRevision: 1,
      titlePolicyVersion: 1,
      updatedAtMs: 10,
      updatedByAccountId: 'acct_me',
    },
    message: {
      id: 'message-one',
      senderAccountId: 'acct_peer',
      text: 'first message',
      createdAtMs: 100,
    },
    ...overrides,
  };
}

test('group replay preparation signature ignores changing message payloads and senders', () => {
  const first = groupMessage();
  const second = groupMessage({
    actor: {
      accountId: 'acct_me',
      displayName: 'Me',
      avatarUrl: null,
      role: 'self',
    },
    message: {
      id: 'message-two',
      senderAccountId: 'acct_me',
      text: 'second message',
      createdAtMs: 200,
    },
  });

  assert.equal(
    cloudGroupSessionPreparationSignature(first, account),
    cloudGroupSessionPreparationSignature(second, account),
  );
});

test('group replay preparation signature invalidates when membership or title changes', () => {
  const original = groupMessage();
  const withMember = groupMessage({
    participants: [
      ...original.participants,
      {
        accountId: 'acct_new',
        displayName: 'New person',
        avatarUrl: null,
        role: 'person',
      },
    ],
  });
  const renamed = groupMessage({
    sessionTitle: {
      ...original.sessionTitle!,
      title: 'renamed',
      titleRevision: 2,
      updatedAtMs: 20,
    },
  });

  const signature = cloudGroupSessionPreparationSignature(original, account);
  assert.notEqual(
    signature,
    cloudGroupSessionPreparationSignature(withMember, account),
  );
  assert.notEqual(
    signature,
    cloudGroupSessionPreparationSignature(renamed, account),
  );
});

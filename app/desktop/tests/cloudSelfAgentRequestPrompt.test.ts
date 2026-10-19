import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { cloudFallbackRunClaimsForMessages } from '../src/features/cloud/cloudAgentFallbackClaims';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { cloudSelfAgentRequestPrompt } from '../src/features/cloud/cloudSelfAgentRequestPrompt';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const account: CloudAccount = {
  accountId: 'acct_me', displayName: 'Owner', primaryEmail: 'owner@example.com', avatarUrl: null,
  avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
};
const route = { model: 'openai-codex/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic', thinking: 'high' };
const request = (text: string, extra: Partial<CloudMessage> = {}): CloudMessage => ({
  messageId: 'wire-request', fromAccountId: account.accountId, toAccountId: account.accountId,
  body: encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text, agentRuntimeRoute: route }),
  sessionId: 'new-thread-session', createdAt: new Date().toISOString(), deliveredAt: null, readAt: null, ...extra,
});
const image = { attachmentId: 'att_1', name: 'Screenshot.png', kind: 'image' as const, mimeType: 'image/png', sizeBytes: 10 };
const claimsFor = (message: CloudMessage) => cloudFallbackRunClaimsForMessages({
  account, contacts: [], messageIndex: buildCloudMessageIndex(account.accountId, { [account.accountId]: [message] }),
  recentSinceMs: Date.now() - 60_000, selfAgentFallbackBeforeMs: Date.now() - 60_000,
});

test('an attachment-only request names its attachments as its prompt', () => {
  assert.equal(cloudSelfAgentRequestPrompt(request('', { attachments: [image] })), 'Attached Screenshot.png');
  assert.equal(cloudSelfAgentRequestPrompt(request('', { attachments: [image, { ...image, attachmentId: 'att_2' }] })), '2 attachments');
  assert.equal(cloudSelfAgentRequestPrompt(request('Look at this', { attachments: [image] })), 'Look at this');
  assert.equal(cloudSelfAgentRequestPrompt(request('')), '');
});

test('an attachment send creates its run', () => {
  const [claim] = claimsFor(request('', { attachments: [image] }));
  assert.equal(claim?.requestMessageId, 'wire-request');
  assert.equal(claim?.prompt, 'Attached Screenshot.png');
});

test('the first message of a new thread creates its run', () => {
  const [claim] = claimsFor(request('hi'));
  assert.equal(claim?.sessionId, 'new-thread-session');
  assert.equal(claim?.prompt, 'hi');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { cloudFallbackRunClaimsForMessages } from '../src/features/cloud/cloudAgentFallbackClaims';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

// Mac-first: a Mac the server accepted as ready runs the owner's own requests,
// hosted-account routes included. Its Cloud claim waits for the fallback window.

const account: CloudAccount = {
  accountId: 'acct_me', displayName: 'Owner', primaryEmail: 'owner@example.com', avatarUrl: null,
  avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
};
const hostedRoute = { model: 'openai-codex/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic', thinking: 'high' };
const nowMs = Date.now();

function request(ageMs: number, route: Record<string, string> | null = hostedRoute): CloudMessage {
  const createdAt = new Date(nowMs - ageMs).toISOString();
  return {
    messageId: 'wire-request', fromAccountId: account.accountId, toAccountId: account.accountId,
    body: encodeCloudDirectMessageEnvelope({
      schemaVersion: 1, kind: 'message', text: 'Summarize my notes',
      ...(route ? { agentRuntimeRoute: route } : {}),
    }),
    sessionId: 'session:self-agent:ready-mac', createdAt, deliveredAt: createdAt, readAt: null,
  };
}

function claimsFor(message: CloudMessage, desktopExecutionReady?: boolean) {
  return cloudFallbackRunClaimsForMessages({
    account, contacts: [],
    messageIndex: buildCloudMessageIndex(account.accountId, { [account.accountId]: [message] }),
    recentSinceMs: nowMs - 10 * 60_000,
    selfAgentFallbackBeforeMs: nowMs - 2 * 60_000,
    ...(desktopExecutionReady === undefined ? {} : { desktopExecutionReady }),
  });
}

test('a device that is not a ready Mac claims a fresh hosted-route request at once', () => {
  for (const ready of [undefined, false]) {
    const claims = claimsFor(request(1_000), ready);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.requestMessageId, 'wire-request');
    assert.equal(claims[0]?.runtimeRoute?.defaultAuthChoice, 'cloud-login:synthetic');
  }
});

test('a ready Mac leaves a fresh hosted-route request to its own desktop claim', () => {
  assert.deepEqual(claimsFor(request(1_000), true), []);
});

test('a ready Mac still hands a hosted-route request to the Cloud after the fallback window', () => {
  const claims = claimsFor(request(3 * 60_000), true);
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.runtimeRoute?.defaultAuthChoice, 'cloud-login:synthetic');
});

test('requests on a local route keep waiting for the fallback window either way', () => {
  for (const ready of [false, true]) {
    assert.deepEqual(claimsFor(request(1_000, null), ready), []);
    assert.equal(claimsFor(request(3 * 60_000, null), ready).length, 1);
  }
});

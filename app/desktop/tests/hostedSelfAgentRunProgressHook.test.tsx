import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CanonicalSessionState } from '../src/kordi-app/types';
import type { CloudAgentRun, CloudAgentRunClaimInput, CloudAuthClient, CloudMessage } from '../src/features/cloud/authClient';
import type { CloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { cloudSelfAgentRequestClientMessageId } from '../src/features/cloud/cloudSelfAgentIdentity';
import { hostedSelfAgentProgressId } from '../src/features/cloud/hostedSelfAgentRunProgress';
import { useHostedSelfAgentRunProgress } from '../src/features/cloud/useHostedSelfAgentRunProgress';

const sessionId = 'session:self-agent:hook';
const requestId = 'cloud-request-hook';
const request: CloudMessage = {
  messageId: requestId, sessionId, fromAccountId: 'acct', toAccountId: 'acct', body: 'Hi',
  createdAt: '2026-09-29T10:00:00Z', deliveredAt: null, readAt: null, direction: 'outgoing',
  clientMessageId: cloudSelfAgentRequestClientMessageId(sessionId, 'local-request-hook'),
};
const claim: CloudAgentRunClaimInput = {
  requestMessageId: requestId, sessionId, ownerAccountId: 'acct', requesterAccountId: 'acct',
  prompt: 'Hi', idempotencyKey: 'hook-test', runtimeRoute: { defaultModel: 'synthetic' },
};
const run = (status: string): CloudAgentRun => ({
  runId: 'run-1', status, sandboxId: null, createdAt: '2026-09-29T10:00:00Z',
  updatedAt: '2026-09-29T10:00:00Z', executionBackend: 'cloud',
});
const baseState = {
  storagePath: '/tmp/test', profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct', createdAtMs: 1, updatedAtMs: 1 },
  identities: [], participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
  sessions: [{ id: sessionId, kind: 'self-agent', title: 'Chat', status: 'active', createdAtMs: 1,
    primaryIdentityId: 'agent:acct', participantIdentityIds: ['agent:acct'], createdByIdentityId: 'human:acct' }],
  messages: [{ id: 'local-request-hook', sessionId, senderIdentityId: 'human:acct', senderRole: 'user',
    messageKind: 'text', contentText: 'Hi', content: {}, status: 'sent', sequenceNum: 1,
    createdAtMs: 10, updatedAtMs: 10, sourceTransport: 'desktop-chat-ui' }],
} as CanonicalSessionState;

async function withHarness(callback: (harness: {
  track: (claim: CloudAgentRunClaimInput, run: CloudAgentRun, token: string) => void;
  state: () => CanonicalSessionState;
  switchAccount: (accountId: string | null) => Promise<void>;
  releaseLookup: (run: CloudAgentRun | null) => void;
  lookups: () => number;
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const root = createRoot(dom.window.document.getElementById('root')!);
  let track!: (claim: CloudAgentRunClaimInput, run: CloudAgentRun, token: string) => void;
  let current = baseState;
  let setAccount!: (accountId: string | null) => void;
  let lookupCount = 0;
  let releaseLookup!: (run: CloudAgentRun | null) => void;
  const client = {
    lookupCloudAgentRunForRequest: async () => {
      lookupCount += 1;
      return new Promise<CloudAgentRun | null>((resolve) => { releaseLookup = resolve; });
    },
  } as unknown as CloudAuthClient;
  const indexRef = { current: { byPeerId: new Map([['acct', [request]]]) } as unknown as CloudMessageIndex };
  function Harness() {
    const [accountId, updateAccount] = useState<string | null>('acct');
    const [state, setState] = useState(baseState);
    setAccount = updateAccount;
    current = state;
    track = useHostedSelfAgentRunProgress({ accountId, client, messageIndexRef: indexRef, setCanonicalSessionState: setState });
    return null;
  }
  try {
    await act(async () => { root.render(<Harness />); });
    await callback({
      track, state: () => current,
      switchAccount: async (accountId) => { await act(async () => { setAccount(accountId); }); },
      releaseLookup: (nextRun) => releaseLookup(nextRun), lookups: () => lookupCount,
    });
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

test('hosted claim shows queued, then running, then clears on terminal status', async () => {
  await withHarness(async (harness) => {
    await act(async () => { harness.track(claim, run('queued'), 'synthetic-token'); });
    const progressId = hostedSelfAgentProgressId(requestId);
    assert.equal(harness.state().messages.find((message) => message.id === progressId)?.status, 'queued');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
    assert.equal(harness.lookups(), 1);
    await act(async () => { harness.releaseLookup(run('running')); await Promise.resolve(); });
    assert.equal(harness.state().messages.find((message) => message.id === progressId)?.status, 'processing');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
    await act(async () => { harness.releaseLookup(run('completed')); await Promise.resolve(); });
    assert.equal(harness.state().messages.some((message) => message.id === progressId), false);
  });
});

test('account switch rejects late claim and late lookup without restoring old progress', async () => {
  await withHarness(async (harness) => {
    const oldTrack = harness.track;
    await act(async () => { oldTrack(claim, run('running'), 'synthetic-token'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
    assert.equal(harness.lookups(), 1);
    await harness.switchAccount('other');
    assert.equal(harness.state().messages.some((message) => message.id === hostedSelfAgentProgressId(requestId)), false);
    await act(async () => {
      oldTrack(claim, run('running'), 'synthetic-token');
      harness.releaseLookup(run('running'));
      await Promise.resolve();
    });
    assert.equal(harness.state().messages.some((message) => message.id === hostedSelfAgentProgressId(requestId)), false);
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
  UpdateCloudSessionTitleInput,
} from '../src/features/cloud/authClient';
import type { SendCloudGroupControlInput } from '../src/features/cloud/cloudGroupControl.types';
import { parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useCloudGroupControlSender } from '../src/features/cloud/useCloudGroupControlSender';
import type { CanonicalSessionState } from '../src/kordi-app/types';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
  });
  return {
    restore() {
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}

test('explicit manual title wins while the canonical state ref is stale', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let sendGroupControl: ((input: SendCloudGroupControlInput) => Promise<void>) | null = null;
  let sentBody = '';
  let persistedTitle: UpdateCloudSessionTitleInput | null = null;
  const sessionId = 'session:group:manual-title-race';
  const manualTitle = {
    title: 'Study group',
    titleSource: 'manual' as const,
    titleRevision: 2,
    titlePolicyVersion: 1,
    updatedAtMs: 2_000,
    updatedByAccountId: 'acct_me',
  };
  const account = {
    accountId: 'acct_me',
    displayName: 'Me',
    primaryEmail: null,
    avatarUrl: null,
    nodeId: null,
    passwordSet: true,
    avatar: {},
  } as CloudAccount;
  const staleState = {
    sessions: [{
      id: sessionId,
      title: 'Message-derived title',
      metadata: { sessionTitleSource: 'auto' },
    }],
    identities: [],
  } as unknown as CanonicalSessionState;
  const sentMessage: CloudMessage = {
    messageId: 'cloud-title-control',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '',
    createdAt: '2026-09-01T00:00:00Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
    sessionId,
  };
  const client = {
    async sendMessage(_token: string, _peerId: string, body: string) {
      sentBody = body;
      return { ...sentMessage, body };
    },
    async updateCloudSessionTitle(
      _token: string,
      _sessionId: string,
      input: UpdateCloudSessionTitleInput,
    ) {
      persistedTitle = input;
      return {
        sessionId,
        ...input,
        updatedByAccountId: 'acct_me',
        updatedAt: '2026-09-01T00:00:00Z',
      };
    },
  } as unknown as CloudAuthClient;

  __setSessionBackendForTests({
    async load() {
      return {
        token: 'test-token',
        accountId: 'acct_me',
        expiresAt: '2099-01-01T00:00:00Z',
      };
    },
    async save() {},
    async clear() {},
  });

  function Harness() {
    sendGroupControl = useCloudGroupControlSender({
      account,
      transport: {
        client,
        messageIndex: buildCloudMessageIndex(account.accountId, {}),
        outbox: null,
        mergeMessage() {},
        async persistOutboxDelivery() {},
        async claimFreshFallback() {},
        async syncDiff() {},
      },
      canonical: {
        state: null,
        stateRef: { current: staleState },
        titleBackfillsRef: { current: new Set() },
        initialMessagesSettled: false,
      },
      reportWarning() {},
    });
    return null;
  }

  try {
    await act(async () => root?.render(<Harness />));
    await act(async () => sendGroupControl?.({
      targetAccountIds: ['acct_peer'],
      kind: 'session-title-update',
      groupId: sessionId,
      groupSpaceId: sessionId,
      groupTitle: manualTitle.title,
      sessionTitle: manualTitle,
      participants: [
        { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
        { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
      ],
    }));

    assert.deepEqual(parseCloudGroupControl(sentBody)?.sessionTitle, manualTitle);
    assert.equal(persistedTitle?.title, manualTitle.title);
    assert.equal(persistedTitle?.titleSource, 'manual');
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    __setSessionBackendForTests(null);
    installed.restore();
  }
});

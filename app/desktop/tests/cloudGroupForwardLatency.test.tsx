import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { CloudAccount, CloudAuthClient } from '../src/features/cloud/authClient';
import type { SendCloudGroupControlInput } from '../src/features/cloud/cloudGroupControl.types';
import { CloudGroupOutbox } from '../src/features/cloud/cloudGroupOutbox';
import { parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useCloudGroupControlSender } from '../src/features/cloud/useCloudGroupControlSender';
import { installDom } from './helpers/transcriptAttachmentDom';

for (const persistent of [false, true]) {
  test(`four forwarded messages finish in order while post-send work is blocked (outbox: ${persistent})`, async () => {
    const { restore } = installDom();
    const root = createRoot(document.createElement('div'));
    let release!: () => void;
    const background = new Promise<void>((resolve) => { release = resolve; });
    const sent: string[] = [];
    let followups = 0;
    let syncs = 0;
    let completed = false;
    let failNext = false;
    let batch: Promise<void> | undefined;
    let send!: ReturnType<typeof useCloudGroupControlSender>;
    const outbox = persistent ? new CloudGroupOutbox('acct_self', {
      load: async () => null, save: async () => {},
    }) : null;
    __setSessionBackendForTests({
      load: async () => ({ token: 'synthetic', accountId: 'acct_self', expiresAt: '2099-01-01' }),
      save: async () => {}, clear: async () => {},
    });
    function Harness() {
      send = useCloudGroupControlSender({
        account: { accountId: 'acct_self', displayName: 'Self', avatar: {} } as CloudAccount,
        canonical: { stateRef: { current: null } },
        transport: {
          client: { sendMessage: async (_token: string, _peer: string, body: string) => {
            if (failNext) { failNext = false; throw new Error('Connection interrupted'); }
            sent.push(body);
            return { messageId: `wire-${sent.length}`, body };
          } } as unknown as CloudAuthClient,
          messageIndex: buildCloudMessageIndex('acct_self', {}), outbox,
          mergeMessage() {}, persistOutboxDelivery: async () => {},
          claimFreshFallback: async () => { followups++; await background; },
          syncDiff: async () => { syncs++; await background; },
        },
        reportWarning() {},
      });
      return null;
    }
    try {
      await act(async () => root.render(<Harness />));
      batch = (async () => {
        for (let index = 0; index < 4; index++) {
          const input: SendCloudGroupControlInput = {
            kind: 'group-message', groupId: 'group', targetAccountIds: ['acct_peer'],
            completion: 'acknowledged',
            message: { id: `forward-${index}`, senderAccountId: 'acct_self', text: `Message ${index}`, createdAtMs: index + 1 },
          };
          await send(input);
        }
        completed = true;
      })();
      await Promise.race([batch, new Promise((resolve) => setTimeout(resolve, 100))]);
      assert.equal(completed, true, 'Forwarding must not wait for background sync or agent work after acknowledgement');
      assert.equal(sent.length, 4);
      assert.deepEqual(sent.map((body) => parseCloudGroupControl(body)?.message?.text), ['Message 0', 'Message 1', 'Message 2', 'Message 3']);
      assert.equal(followups, 4, 'Agent follow-up still runs for every message');
      assert.equal(syncs, 4, 'Synchronization still runs');
      const retryInput: SendCloudGroupControlInput = {
        kind: 'group-message', groupId: 'group', targetAccountIds: ['acct_peer'],
        completion: 'acknowledged', retryFailed: true,
        message: { id: 'forward-retry', senderAccountId: 'acct_self', text: 'Retry message', createdAtMs: 5 },
      };
      failNext = true;
      await assert.rejects(send(retryInput), /Connection interrupted|not been delivered/);
      assert.equal(sent.length, 4, 'A failed delivery must not count as forwarded');
      await send(retryInput);
      assert.equal(sent.length, 5);
      if (persistent) {
        await send(retryInput);
        assert.equal(sent.length, 5, 'Retrying an acknowledged group message must not duplicate delivery');
      }
    } finally {
      release();
      await batch;
      await act(async () => root.unmount());
      __setSessionBackendForTests(null);
      restore();
    }
  });
}

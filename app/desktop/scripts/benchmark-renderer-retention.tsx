import { JSDOM } from 'jsdom';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { setImmediate } from 'node:timers/promises';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { useCloudCollaborationMessageStore } from '../src/features/cloud/useCloudCollaborationMessageStore';

if (!globalThis.gc) throw new Error('Run with node --expose-gc --import tsx scripts/benchmark-renderer-retention.tsx');
const dom = new JSDOM('<div id="root"></div>');
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(window, { __TAURI_INTERNALS__: {} });
let store!: ReturnType<typeof useCloudCollaborationMessageStore>;
const account = { accountId: 'fixture-account' } as CloudAccount;
function Harness({ active = 'session-0' }) {
  const current = useCloudCollaborationMessageStore(account, active);
  useLayoutEffect(() => { store = current; });
  return null;
}
function message(peer: number, index: number): CloudMessage {
  return {
    messageId: `message-${peer}-${index}`, fromAccountId: `peer-${peer}`, toAccountId: account.accountId,
    sessionId: `session-${peer}`, conversationSequence: index + 1, direction: 'incoming', readAt: null,
    createdAt: new Date(index * 1000).toISOString(), deliveredAt: new Date(index * 1000).toISOString(),
    body: JSON.stringify({ text: 'x'.repeat(2_048), peer, index }),
  };
}
const root = createRoot(document.getElementById('root')!);
const checkpoints: Array<{ phase: string; backingRows: number; displayRows: number; heapMiB: number }> = [];
async function checkpoint(phase: string) {
  await setImmediate();
  globalThis.gc!();
  await setImmediate();
  globalThis.gc!();
  checkpoints.push({
    phase,
    backingRows: Object.values(store.valueRef.current).reduce((sum, rows) => sum + rows.length, 0),
    displayRows: store.index.allMessages.length,
    heapMiB: Number((process.memoryUsage().heapUsed / 1024 ** 2).toFixed(2)),
  });
}
try {
  await act(async () => root.render(createElement(Harness)));
  await checkpoint('empty');
  await act(async () => store.setValue(Object.fromEntries(Array.from({ length: 20 }, (_, peer) => [
    `peer-${peer}`, Array.from({ length: 1_000 }, (_, index) => message(peer, index)),
  ]))));
  await act(async () => { store.onGroupRecoverySettled(); store.onSelfAgentRecoverySettled(); });
  for (let round = 0; round < 3; round += 1) {
    for (let peer = 0; peer < 20; peer += 1) {
      await act(async () => root.render(createElement(Harness, { active: `session-${peer}` })));
      await act(async () => store.setValue((current) => ({
        ...current,
        [`peer-${peer}`]: [...current[`peer-${peer}`], ...Array.from({ length: 100 }, (_, index) => message(peer, 1_000 + round * 100 + index))],
      })));
    }
    await checkpoint(`after-${round + 1}-chat-cycles`);
  }
  process.stdout.write(`${JSON.stringify({ fixture: { peers: 20, initialMessages: 20_000, messageTextBytes: 2_048 }, checkpoints })}\n`);
} finally {
  await act(async () => root.unmount());
  dom.window.close();
}

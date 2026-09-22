import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { useCompanionReadPresentation } from '../src/pages/useCompanionReadPresentation';
import { useKordiShellArgs } from '../src/app/useKordiShellArgs';
import { buildChatsPageProps } from '../src/app/mainContentShellBuilders';
import type { KordiShellCompositionArgs } from '../src/app/kordiShellComposition.types';
import { useCompanionSessionRead } from '../src/app/useCompanionSessionRead';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { SidebarUnreadBadge } from '../src/pages/workspaceSidebar.shared';
import { conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import type { CanonicalSessionState } from '../src/kordi-app/types';
import type { CloudAccount } from '../src/features/cloud/authClient';

const agentId = 'session:agent:companion';
const otherId = 'session:agent:other';
function fixture(): CanonicalSessionState {
  return {
    storagePath: '',
    profile: { id: 'profile', humanIdentityId: 'human:me', storageRoot: '', createdAtMs: 1, updatedAtMs: 1 },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:assistant', kind: 'agent', displayName: 'Assistant', source: 'local', avatarKey: 'assistant', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [agentId, otherId].map(id => ({ id, kind: 'direct', title: 'Agent test', status: 'active', createdByIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1, metadata: { cloudUnreadCount: 1 } })),
    participants: [agentId, otherId].flatMap(sessionId => [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedAtMs: 1 },
      { sessionId, identityId: 'agent:assistant', role: 'agent', state: 'active', addedAtMs: 1 },
    ]),
    messages: [agentId, otherId].map(sessionId => ({ id: `${sessionId}:1`, sessionId, senderIdentityId: 'agent:assistant', senderRole: 'agent', messageKind: 'text', contentText: 'Synthetic agent reply', status: 'complete', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1 })),
    delegatedExchanges: [], presence: [], contextSnapshots: [],
  };
}

async function mount() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  let focused = true;
  let visible = true;
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => focused });
  Object.defineProperty(dom.window.document, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' });
  const replacements = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const localReads: string[] = [];
  const cloudReads: string[] = [];
  const pendingReads: (() => void)[] = [];
  const readWaiters = new Set<() => void>();
  mockIPC((command, args) => {
    assert.equal(command, 'desktop_canonical_mark_session_read');
    const { sessionId, messageId } = (args as { request: { sessionId: string; messageId: string } }).request;
    localReads.push(messageId);
    const result = new Promise(resolve => {
      pendingReads.push(() => resolve({ sessionId, identityId: 'human:me', lastSeenAtMs: 1, lastReadMessageId: messageId, lastReadSequenceNum: Number(messageId.split(':').at(-1)) }));
    });
    for (const notify of readWaiters) notify();
    return result;
  });
  const markRead = async (ids: string[]) => { cloudReads.push(...ids); };
  const scrollRef = { current: { scrollHeight: 1000, scrollTop: 800, clientHeight: 200 } as HTMLDivElement };
  let scroll!: (atLatest?: boolean) => void;
  let update!: React.Dispatch<React.SetStateAction<CanonicalSessionState | null>>;
  function Panel({ sessionId, presented, onChange }: { sessionId: string; presented: boolean; onChange: (id: string | null) => void }) {
    scroll = useCompanionReadPresentation({ sessionId, isPresented: presented, scrollRef, onChange });
    return null;
  }
  function Harness({ sessionId, presented, mounted }: { sessionId: string; presented: boolean; mounted: boolean }) {
    const [state, setState] = useState<CanonicalSessionState | null>(fixture);
    const [localUnread, setLocalUnread] = useState({ [agentId]: 1, [otherId]: 1 });
    const clearUnreadForSession = useCallback((id?: string | null) => {
      if (id) setLocalUnread(current => ({ ...current, [id]: 0 }));
    }, []);
    update = setState;
    const setReadableId = useCompanionSessionRead({ enabled: true, account: { accountId: 'account:me' } as CloudAccount, canonicalState: state, setCanonicalState: setState, markRead, localSessionUnreadCounts: localUnread, clearUnreadForSession });
    const model = createCanonicalSessionReadModel(state);
    const count = [agentId, otherId].reduce((sum, id) => sum + Math.max(localUnread[id] ?? 0, model?.applyConversation(conversation({ id, canonicalSessionId: id, unread: 1 }), () => '').unread ?? 0), 0);
    const shell = useKordiShellArgs({
      workspacePanels: { onCompanionReadPresentationChange: setReadableId },
      environment: { desktopAuthState: null },
    } as unknown as KordiShellCompositionArgs);
    const page = buildChatsPageProps(shell.mainContent);
    assert.equal(page.transcript.onCompanionReadPresentationChange, setReadableId);
    return <><SidebarUnreadBadge count={count} scope="agent" />{mounted && <Panel sessionId={sessionId} presented={presented} onChange={page.transcript.onCompanionReadPresentationChange!} />}</>;
  }
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  let props = { sessionId: agentId, presented: true, mounted: true };
  const render = async (next: Partial<typeof props> = {}) => {
    props = { ...props, ...next };
    await act(async () => { root.render(<Harness {...props} />); });
  };
  await render();
  return {
    localReads, cloudReads, render,
    async completeRead(count: number) {
      // Native invocation loads asynchronously; act alone does not await IPC.
      await act(async () => {
        if (localReads.length < count) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              readWaiters.delete(notify);
              reject(new Error(`Expected ${count} native reads, received ${localReads.length}`));
            }, 5_000);
            const notify = () => {
              if (localReads.length < count) return;
              clearTimeout(timer);
              readWaiters.delete(notify);
              resolve();
            };
            readWaiters.add(notify);
            notify();
          });
        }
        pendingReads[count - 1]();
      });
    },
    count: () => Number(host.querySelector('[data-unread-count]')?.getAttribute('data-unread-count') ?? 0),
    scroll: async (atLatest?: boolean) => { await act(async () => { scroll(atLatest); }); },
    focus: async (value: boolean) => { focused = value; await act(async () => { dom.window.dispatchEvent(new dom.window.Event(value ? 'focus' : 'blur')); }); },
    visibility: async (value: boolean) => { visible = value; await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); }); },
    reply: async (sequence: number) => { await act(async () => { update(current => ({ ...current!, messages: [...current!.messages, { ...current!.messages[0], id: `${agentId}:${sequence}`, sequenceNum: sequence, createdAtMs: sequence }] })); }); },
    async close() {
      await act(async () => root.unmount());
      clearMocks();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}

test('reading the companion clears its Agent badge contribution and preserves unrelated unread', async () => {
  const h = await mount();
  try {
    assert.equal(h.count(), 2);
    assert.deepEqual(h.localReads, []);
    await h.scroll();
    await h.completeRead(1);
    assert.deepEqual(h.localReads, [`${agentId}:1`]);
    assert.deepEqual(h.cloudReads, [agentId]);
    assert.equal(h.count(), 1);
    await h.reply(2);
    await h.completeRead(2);
    assert.deepEqual(h.localReads, [`${agentId}:1`, `${agentId}:2`]);
    assert.equal(h.count(), 1);
    await h.scroll(false);
    await h.reply(3);
    assert.equal(h.localReads.length, 2);
    assert.equal(h.cloudReads.length, 2);
    assert.equal(h.count(), 2);
    await h.scroll(true);
    await h.completeRead(3);
    assert.equal(h.count(), 1);
  } finally { await h.close(); }
});

test('companion replies remain unread while the app is unfocused or hidden', async () => {
  const h = await mount();
  try {
    await h.focus(false);
    await h.scroll(true);
    assert.equal(h.localReads.length, 0);
    assert.equal(h.cloudReads.length, 0);
    await h.focus(true);
    await h.completeRead(1);
    assert.equal(h.count(), 1);
    await h.visibility(false);
    await h.reply(2);
    assert.equal(h.localReads.length, 1);
    assert.equal(h.cloudReads.length, 1);
    await h.visibility(true);
    await h.completeRead(2);
    assert.equal(h.localReads.length, 2);
    assert.equal(h.cloudReads.length, 2);
  } finally { await h.close(); }
});

test('hidden destinations, panel closure, and session switching cannot read an unseen reply', async () => {
  const h = await mount();
  try {
    await h.render({ presented: false });
    await h.scroll(true);
    assert.equal(h.localReads.length, 0);
    assert.equal(h.cloudReads.length, 0);
    await h.render({ presented: true });
    assert.equal(h.localReads.length, 0);
    assert.equal(h.cloudReads.length, 0);
    await h.scroll(true);
    await h.completeRead(1);
    assert.equal(h.count(), 1);
    await h.render({ sessionId: otherId });
    assert.equal(h.localReads.length, 1);
    assert.equal(h.cloudReads.length, 1);
    await h.scroll(true);
    await h.completeRead(2);
    assert.equal(h.count(), 0);
    await h.render({ mounted: false });
    await h.reply(2);
    assert.equal(h.localReads.length, 2);
    assert.equal(h.cloudReads.length, 2);
    assert.equal(h.count(), 1);
  } finally { await h.close(); }
});


test('returning from a hidden destination requires a fresh transcript position', async () => {
  const h = await mount();
  try {
    await h.scroll(true);
    await h.completeRead(1);
    await h.render({ presented: false });
    await h.reply(2);
    assert.equal(h.localReads.length, 1);
    assert.equal(h.cloudReads.length, 1);
    await h.render({ presented: true });
    assert.equal(h.localReads.length, 1);
    assert.equal(h.cloudReads.length, 1);
    await h.scroll(true);
    await h.completeRead(2);
    assert.equal(h.localReads.length, 2);
    assert.equal(h.cloudReads.length, 2);
  } finally { await h.close(); }
});

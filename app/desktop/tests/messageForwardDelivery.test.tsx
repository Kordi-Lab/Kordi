import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useKordiMessageActions } from '../src/app/useKordiMessageActions';
import { conversation, contact } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import { installDom } from './helpers/transcriptAttachmentDom';
import { canonicalState } from './helpers/cloudGroupOutboxFixtures';
import type { AppendCanonicalMessageRequest } from '../src/lib/desktop';
import type { SendCloudGroupControlInput } from '../src/features/cloud/cloudGroupControl.types';

test('batch retry skips completed messages and reuses the request ID when forwarding to a contact without history', async () => {
  const { dom, restore } = installDom();
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const active = conversation({ messages: [
    { id: 'first', role: 'person', sender: 'Alice', text: 'First message', time: '10:00' },
    { id: 'second', role: 'person', sender: 'Alice', text: 'Second message', time: '10:01' },
  ] });
  const person = contact({ id: 'cloud:maya', name: 'Maya', entityType: 'user', sourceHostId: 'cloud', sourceParticipantId: 'maya', contactStatus: 'accepted' });
  let model!: ReturnType<typeof useKordiMessageActions>;
  const sends: Array<{ body: string; requestId: string | undefined }> = [];
  const navigations: string[] = [];
  const noop = () => {};
  const args: Parameters<typeof useKordiMessageActions>[0] = {
    activeConversation: active, conversations: [active], contacts: [person], draftSessionId: active.id,
    isNativeShell: false, transcriptScrollRef: { current: null }, setActiveConversationId: (id) => navigations.push(id),
    setDesktopChatError: noop, setChatQuoteBySessionId: noop, canonicalState: null, setCanonicalState: noop,
    account: null, collaborationState: null,
    cloudTransport: {
      prepareCloudForwardAttachments: async () => [],
      sendCloudCollaborationMessage: async (_id, body, _attachments, options) => {
        sends.push({ body, requestId: options?.clientMessageId });
        if (sends.length === 2) throw new Error('Connection interrupted');
        return {};
      },
      sendCloudGroupControl: async () => {}, setCloudMessageReaction: async () => {},
      editCloudMessage: async () => {}, deleteCloudMessage: async () => {},
    } as unknown as Parameters<typeof useKordiMessageActions>[0]['cloudTransport'],
  };
  function Harness() { model = useKordiMessageActions(args); return model.messageForwardDialog; }
  const button = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === text)!;
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => model.onSelectAllMessages());
    await act(async () => model.onForwardSelectedMessages());
    const destination = [...document.querySelectorAll<HTMLButtonElement>('[data-message-forward-destination]')].find((item) => item.textContent?.includes('Maya'))!;
    assert.ok(destination);
    await act(async () => destination.click());
    await act(async () => button('Forward').click());
    assert.equal(sends.length, 2);
    assert.equal(navigations.length, 0);
    assert.ok(button('Try again'));
    await act(async () => button('Try again').click());
    assert.equal(sends.length, 3);
    assert.equal(sends[1].requestId, sends[2].requestId);
    assert.notEqual(sends[0].requestId, sends[1].requestId);
    assert.match(sends[0].requestId!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(sends[1].body, sends[2].body);
    assert.match(navigations[0], /maya:person$/);
    assert.ok(document.querySelector('.forward-success'));
  } finally {
    await act(async () => root.unmount());
    // Destination reveal is deliberately deferred by the app after navigation.
    await new Promise((resolve) => setTimeout(resolve, 90));
    restore();
  }
});

test('native group batch updates individual rows, reports progress, and retries without appending duplicates', async () => {
  const { dom, restore } = installDom();
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const root = createRoot(document.createElement('div'));
  const active = conversation({ messages: Array.from({ length: 4 }, (_, index) => ({
    id: `source-${index}`, role: 'person' as const, sender: 'Alice', text: `Message ${index}`, time: '10:00',
  })) });
  const group = conversation({
    id: 'session:group:destination', canonicalSessionId: 'session:group:destination', name: 'Study group', directness: 'Group chat',
    canonicalParticipants: [{ id: 'peer', name: 'Peer', kind: 'human', role: 'delegate', source: 'cloud',
      sourceHostId: 'cloud', sourceIdentityId: 'acct_peer', avatarKey: 'peer' }],
  });
  const commands: string[] = [];
  const requests: AppendCanonicalMessageRequest[] = [];
  const sends: SendCloudGroupControlInput[] = [];
  let state = canonicalState();
  const originalRow = state.messages[0];
  let model!: ReturnType<typeof useKordiMessageActions>;
  let release!: () => void;
  const secondSend = new Promise<void>((resolve) => { release = resolve; });
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { request: AppendCanonicalMessageRequest }) => {
    commands.push(command);
    assert.equal(command, 'desktop_canonical_append_message_fast');
    requests.push(args.request);
    return { ...args.request, sequenceNum: requests.length, updatedAtMs: args.request.createdAtMs };
  } } });
  const noop = () => {};
  const args: Parameters<typeof useKordiMessageActions>[0] = {
    activeConversation: active, conversations: [active, group], draftSessionId: active.id, isNativeShell: true,
    transcriptScrollRef: { current: null }, setActiveConversationId: noop, setDesktopChatError: noop,
    setChatQuoteBySessionId: noop, canonicalState: state,
    setCanonicalState: (update) => { state = (typeof update === 'function' ? update(state) : update)!; },
    account: { accountId: 'acct_self' } as NonNullable<Parameters<typeof useKordiMessageActions>[0]['account']>,
    collaborationState: null,
    cloudTransport: {
      prepareCloudForwardAttachments: async () => [], sendCloudCollaborationMessage: async () => ({}),
      sendCloudGroupControl: async (input: SendCloudGroupControlInput) => {
        sends.push(input);
        if (sends.length === 2) { await secondSend; throw new Error('Connection interrupted'); }
      },
      setCloudMessageReaction: async () => {}, editCloudMessage: async () => {}, deleteCloudMessage: async () => {},
    } as unknown as Parameters<typeof useKordiMessageActions>[0]['cloudTransport'],
  };
  function Harness() { model = useKordiMessageActions(args); return model.messageForwardDialog; }
  const button = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === text)!;
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => model.onSelectAllMessages());
    await act(async () => model.onForwardSelectedMessages());
    await act(async () => document.querySelector<HTMLButtonElement>(`[data-message-forward-destination="${group.id}"]`)!.click());
    await act(async () => button('Forward').click());
    // The native bridge is imported lazily; wait for that boundary without resolving delivery.
    for (let attempt = 0; sends.length < 2 && attempt < 50; attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    assert.equal(sends.length, 2);
    assert.ok(button('Forwarding 1/4…'));
    assert.equal(button('Done'), undefined);
    await act(async () => release());
    assert.ok(button('Try again'));
    await act(async () => button('Try again').click());
    assert.ok(document.querySelector('.forward-success'));
    assert.equal(commands.length, 4, 'Only one row write per forwarded message');
    assert.equal(state.messages[0], originalRow, 'Unrelated chat rows retain their identity');
    assert.equal(state.messages.length, 5);
    assert.deepEqual(sends.map((input) => input.message?.text), ['Message 0', 'Message 1', 'Message 1', 'Message 2', 'Message 3']);
    assert.equal(sends[1].message?.id, sends[2].message?.id);
    assert.ok(sends.every((input) => input.completion === 'acknowledged'));
    assert.deepEqual(requests.map((request) => request.createdAtMs! - requests[0].createdAtMs!), [0, 1, 2, 3]);
  } finally {
    release();
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 90));
    restore();
  }
});

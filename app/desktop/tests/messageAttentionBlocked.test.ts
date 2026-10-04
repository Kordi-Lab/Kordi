import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, useRef } from 'react';

import { __setSessionBackendForTests } from '../src/features/cloud/session';
import {
  messageAttentionSnapshot,
  newMessageAttentionEvents,
} from '../src/features/notifications/messageAttentionPolicy';
import { useDesktopMessageAttention } from '../src/features/notifications/useDesktopMessageAttention';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import {
  __resetCloudBlocksForTests,
  currentBlockedIdentityIds,
  rememberBlockedAccount,
  useCloudBlocks,
} from '../src/features/safety/useCloudBlocks';
import type { CanonicalIdentity, Conversation, Message } from '../src/kordi-app/types';
import { mountInDom, stubCloudNetwork } from './helpers/safetyDom';

const BLOCKED = 'human:acct_blocked';

function message(id: string, senderIdentityId: string, text: string): Message {
  return { id, role: 'person', sender: senderIdentityId.slice('human:acct_'.length), senderIdentityId, text, time: '' };
}

function group(messages: Message[], unread: number): Conversation {
  return {
    id: 'session:group:team',
    canonicalSessionId: 'session:group:team',
    name: 'Team',
    type: 'group',
    subtitle: '',
    unread,
    collaborationSources: [],
    trust: '',
    directness: '',
    participants: [],
    messages,
  };
}

const blockedRow = {
  accountId: 'acct_blocked', kordiId: '123456789', displayName: 'Blocked', avatarUrl: null, blockedAt: '2026-10-01T00:00:00Z',
};

test('messages from a suppressed sender do not notify, and other senders still do', () => {
  const first = group([message('m1', 'human:acct_ana', 'Hi')], 1);
  const previous = messageAttentionSnapshot([first]);
  const fromBlocked = group([...first.messages, message('m2', BLOCKED, 'Buy now')], 2);
  const suppressed = new Set([BLOCKED]);

  assert.deepEqual(newMessageAttentionEvents({ previous, conversations: [fromBlocked], suppressedSenderIdentityIds: suppressed }), []);
  assert.equal(
    newMessageAttentionEvents({ previous, conversations: [fromBlocked] })[0]?.messageId,
    'm2',
    'without a suppressed set the same message notifies',
  );

  const afterBlocked = messageAttentionSnapshot([fromBlocked]);
  const fromAna = group([...fromBlocked.messages, message('m3', 'human:acct_ana', 'Lunch?')], 3);
  assert.deepEqual(
    newMessageAttentionEvents({ previous: afterBlocked, conversations: [fromAna], suppressedSenderIdentityIds: suppressed })
      .map((event) => event.messageId),
    ['m3'],
  );
});

test('agents of a suppressed account do not notify either', () => {
  const first = group([message('m1', 'human:acct_ana', 'Hi')], 1);
  const previous = messageAttentionSnapshot([first]);
  const agent = (id: string, senderIdentityId: string, senderOwnerIdentityId?: string): Message => ({
    id, role: 'external-agent', sender: 'Helper', senderIdentityId, senderOwnerIdentityId, text: 'Buy now', time: '',
  });
  for (const agentMessage of [
    agent('m2', 'agent:cloud-agent:cloud_agent_helper', BLOCKED),
    // A default agent names its owner even before the owner's identity loads.
    agent('m3', 'agent:cloud-agent:cloud-agent:acct_blocked'),
  ]) {
    const next = group([...first.messages, agentMessage], 2);
    assert.deepEqual(
      newMessageAttentionEvents({ previous, conversations: [next], suppressedSenderIdentityIds: new Set([BLOCKED]) }),
      [],
    );
    assert.equal(newMessageAttentionEvents({ previous, conversations: [next] })[0]?.messageId, agentMessage.id);
  }
  const fromOtherAgent = group([...first.messages, agent('m4', 'agent:cloud-agent:cloud_agent_other', 'human:acct_ana')], 2);
  assert.equal(
    newMessageAttentionEvents({ previous, conversations: [fromOtherAgent], suppressedSenderIdentityIds: new Set([BLOCKED]) })[0]?.messageId,
    'm4',
  );
});

test('agent messages carry their owner identity for notification rules', () => {
  const identity = (id: string, kind: string, ownerIdentityId?: string): CanonicalIdentity => ({
    id, kind, displayName: id, ownerIdentityId, source: 'cloud', avatarKey: id, createdAtMs: 1, updatedAtMs: 1,
  });
  const identities = new Map([
    [BLOCKED, identity(BLOCKED, 'human')],
    ['agent:cloud-agent:cloud_agent_helper', identity('agent:cloud-agent:cloud_agent_helper', 'agent', BLOCKED)],
  ]);
  const canonical = (id: string, senderIdentityId: string, senderRole: string) => ({
    id, sessionId: 'session:group:team', senderIdentityId, senderRole, messageKind: 'text', contentText: 'Hello',
    status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1,
  });
  const fromAgent = mapCanonicalMessage(canonical('a1', 'agent:cloud-agent:cloud_agent_helper', 'external-agent'), identities, 'human:acct_me');
  assert.equal(fromAgent?.senderOwnerIdentityId, BLOCKED);
  const fromPerson = mapCanonicalMessage(canonical('p1', BLOCKED, 'person'), identities, 'human:acct_me');
  assert.equal(fromPerson?.senderOwnerIdentityId, undefined);
});

test('the blocked identity list uses canonical human identities', () => {
  __resetCloudBlocksForTests();
  try {
    rememberBlockedAccount('acct_me', blockedRow);
    assert.deepEqual([...currentBlockedIdentityIds('acct_me')], [BLOCKED]);
    assert.deepEqual([...currentBlockedIdentityIds('acct_other')], []);
  } finally {
    __resetCloudBlocksForTests();
  }
});

test('desktop notifications skip messages from accounts the signed-in person blocked', async () => {
  __resetCloudBlocksForTests();
  __setSessionBackendForTests({
    load: async () => ({ token: 'tok', accountId: 'acct_me', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => undefined,
    clear: async () => undefined,
  });
  const network = stubCloudNetwork(({ path }) => (
    path === '/v1/cloud/blocks' ? Response.json({ blocks: [blockedRow] }) : new Response('', { status: 404 })
  ));
  const shown: string[] = [];
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const previousNotification = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  class RecordingNotification {
    static permission = 'granted';
    onclick: (() => void) | null = null;
    constructor(title: string, options?: { body?: string }) {
      shown.push(`${title}: ${options?.body ?? ''}`);
    }
  }
  Object.defineProperty(target, 'Notification', { configurable: true, writable: true, value: RecordingNotification });

  function Attention({ conversations }: { conversations: Conversation[] }) {
    useCloudBlocks({ accountId: 'acct_me' });
    const scrollRef = useRef<HTMLElement | null>(null);
    useDesktopMessageAttention({
      isNativeShell: false,
      attentionReady: true,
      activeNav: 'contacts',
      activeConversationId: '',
      chatTranscriptScrollRef: scrollRef,
      conversations,
      totalUnreadCount: conversations.reduce((sum, item) => sum + (item.unread ?? 0), 0),
      onOpenSession: () => undefined,
    });
    return null;
  }

  const dom = await mountInDom();
  try {
    const first = group([message('m1', 'human:acct_ana', 'Hi')], 1);
    await dom.render(createElement(Attention, { conversations: [first] }));
    assert.ok(network.requests.some((request) => request.path === '/v1/cloud/blocks'), 'the block list loaded');

    const fromBlocked = group([...first.messages, message('m2', BLOCKED, 'Buy now')], 2);
    await dom.render(createElement(Attention, { conversations: [fromBlocked] }));
    assert.deepEqual(shown, [], 'no notification for the blocked sender');

    const fromAna = group([...fromBlocked.messages, message('m3', 'human:acct_ana', 'Lunch?')], 3);
    await dom.render(createElement(Attention, { conversations: [fromAna] }));
    assert.deepEqual(shown, ['ana: Lunch?']);
  } finally {
    await dom.cleanup();
    network.restore();
    if (previousNotification) Object.defineProperty(target, 'Notification', previousNotification);
    else delete target.Notification;
    __setSessionBackendForTests(null);
    __resetCloudBlocksForTests();
  }
});

import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type {
  CloudAccount,
  CloudMessage,
} from '../src/features/cloud/authClient';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import {
  cloudBootstrapPeerIds,
  cloudMessagesAuthoritativeForContext,
  cloudMessagesByPeerEqual,
  cloudSessionForksByIdEqual,
  cloudUnreadReadinessContextKey,
  cloudUnreadReadyForContext,
  cloudUnreadStatusForContext,
  createAccountScopedSingleFlight,
  markCloudMessagesReadLocally,
  mergeCloudMessagesByPeerSnapshot,
  shouldRefreshCloudForVisibility,
  shouldRunCloudFocusRefresh,
  transitionCloudUnreadReadiness,
} from '../src/features/cloud/cloudMessageSyncState';

const cloudCollaborationSource = () => readFileSync(
  new URL('../src/features/cloud/useCloudCollaborationState.ts', import.meta.url),
  'utf8',
);
const cloudMessageSyncSource = () => readFileSync(
  new URL('../src/features/cloud/useCloudMessageSync.ts', import.meta.url),
  'utf8',
);
const cloudFocusRefreshSource = () => readFileSync(
  new URL('../src/features/cloud/useCloudFocusRefresh.ts', import.meta.url),
  'utf8',
);
const cloudReadReceiptsSource = () => readFileSync(
  new URL('../src/features/cloud/useCloudMessageReadReceipts.ts', import.meta.url),
  'utf8',
);

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: null,
};

const message: CloudMessage = {
  messageId: 'msg_1',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello from cloud',
  createdAt: '2026-05-11T10:00:00Z',
  deliveredAt: null,
  readAt: null,
  direction: 'incoming',
};

test('cloud startup renders the durable chat cache before catch-up and settles after history backfill', () => {
  const source = cloudMessageSyncSource();

  assert.match(source, /if \(!account \|\| !contactsSettled \|\| !cloudUnreadContextKey\) return;/);
  assert.match(
    source,
    /startupSnapshotContextRef\.current !== cloudUnreadContextKey[\s\S]*bootstrapCloudMessages\(\)/,
  );
  assert.match(
    source,
    /request\.mode === 'bootstrap'[\s\S]*Promise\.all\(\[[\s\S]*hydrateChatLocalState\(generation\)[\s\S]*refreshCloudAgents\(generation\)[\s\S]*syncDiffOnceForGeneration\(generation, request\.mode === 'full'\)[\s\S]*hydrateMissingChatHistory\(generation\)[\s\S]*markUnreadReadiness\('ready'/,
  );
  assert.doesNotMatch(
    source,
    /startupSnapshotContextRef\.current = cloudUnreadContextKey;\s*void refreshCloudAgents/,
    'agent catalog refresh must finish before an advanced event cursor is applied',
  );
  assert.match(
    source,
    /agentsRef\.current = cloudAgentsById;\s*setAgents/,
    'cursor sync must publish the next agent catalog to its live ref atomically',
  );
  assert.doesNotMatch(
    source,
    /client\.listMessageSnapshot|refreshMessagesOnce/,
    'chat startup must not depend on the one-conversation-per-peer snapshot path',
  );
  assert.match(
    source,
    /while \(true\)[\s\S]*syncCloudEvents\([\s\S]*CLOUD_SYNC_EVENT_PAGE_LIMIT[\s\S]*if \(!result\.hasMore\) break/,
    'initial event replay must drain every page before publishing the catalog',
  );
  assert.doesNotMatch(
    source,
    /pass < 20/,
    'a fixed page cap makes large accounts publish partial session catalogs',
  );
  assert.match(
    source,
    /if \(result\.fallbackRequired\) \{[\s\S]*cursorOverride = '0';[\s\S]*continue;/,
    'an unusable cursor must recover through chat bootstrap',
  );
  assert.doesNotMatch(
    source,
    /fallbackRequired[\s\S]{0,800}listMessageSnapshot/,
    'chat cursor recovery must never fall back to peer snapshots',
  );
});

test('normal Cloud events request diff sync instead of full snapshots', () => {
  const source = cloudCollaborationSource();
  const focusSource = cloudFocusRefreshSource();
  const readSource = cloudReadReceiptsSource();
  const fullRefreshCalls = source.match(/void refreshCloudMessages\(\)/g) ?? [];

  assert.equal(
    fullRefreshCalls.length,
    0,
    'normal events and startup should use their coordinated sync entry points',
  );
  assert.match(
    focusSource,
    /lastRefreshAtRef\.current = now;\s*void syncCloudCollaborationDiff\(\)/,
  );
  assert.match(
    readSource,
    /markSessionMessagesRead[\s\S]*void sync\(\)/,
  );
});

test('chat cache hydration keeps attachments metadata-only', () => {
  const source = cloudMessageSyncSource();
  const start = source.indexOf('const hydrateChatLocalState');
  const end = source.indexOf('const hydrateMissingChatHistory', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const bootstrap = source.slice(start, end);

  assert.match(bootstrap, /cloudMessageMetadataOnly/);
  assert.doesNotMatch(bootstrap, /resolveCloudMessageAttachments|downloadAttachmentContent/);
});

test('Cloud focus refresh is throttled across focus, visibility, and pageshow bursts', () => {
  assert.equal(shouldRefreshCloudForVisibility('visible'), true);
  assert.equal(shouldRefreshCloudForVisibility('hidden'), false);
  assert.equal(shouldRunCloudFocusRefresh(20_000, 0), true);
  assert.equal(shouldRunCloudFocusRefresh(20_100, 20_000), false);
  assert.equal(shouldRunCloudFocusRefresh(25_000, 20_000), true);
});

test('Cloud reactivation keeps hot cache interactive before running background refresh', () => {
  const source = cloudFocusRefreshSource();
  assert.match(
    source,
    /CLOUD_FOCUS_REFRESH_DELAY_MS/,
    'expected a short Cloud reactivation refresh delay constant',
  );
  assert.match(
    source,
    /refreshTimerRef/,
    'expected Cloud focus refreshes to coalesce into one delayed timer',
  );
  assert.match(
    source,
    /window\.setTimeout\([\s\S]*runRefresh,[\s\S]*CLOUD_FOCUS_REFRESH_DELAY_MS/,
    'focus refresh should be scheduled after the hot-cache frame',
  );
  assert.match(
    source,
    /window\.clearTimeout\(refreshTimerRef\.current\)/,
    'bursts should cancel the previous delayed refresh timer',
  );
});

test('Cloud full message refreshes are single-flight and account-safe', () => {
  const run = createAccountScopedSingleFlight();
  let releaseFirstAccount!: () => void;
  const firstAccountBlocked = new Promise<void>((resolve) => {
    releaseFirstAccount = resolve;
  });
  let firstAccountStarts = 0;
  let secondAccountStarts = 0;

  const first = run('acct_first', async () => {
    firstAccountStarts += 1;
    await firstAccountBlocked;
  });
  const duplicate = run('acct_first', async () => {
    firstAccountStarts += 1;
  });
  const second = run('acct_second', async () => {
    secondAccountStarts += 1;
  });

  assert.equal(duplicate, first, 'same-account refreshes should share one promise');
  assert.equal(firstAccountStarts, 1);
  assert.equal(
    secondAccountStarts,
    1,
    'a new account must not wait behind the old account refresh',
  );

  releaseFirstAccount();
  return Promise.all([first, duplicate, second]).then(() => undefined);
});

test('cloud session fork map equality compares structural fork lineage', () => {
  const left = {
    child: {
      forkSessionId: 'child',
      parentSessionId: 'parent',
      parentMessageId: 'msg:parent',
      createdByAccountId: 'acct_me',
      createdAt: '2026-05-17T09:00:00Z',
    },
  };
  const right = { child: { ...left.child } };
  const changed = {
    child: { ...left.child, parentMessageId: 'msg:other' },
  };

  assert.equal(cloudSessionForksByIdEqual(left, right), true);
  assert.equal(cloudSessionForksByIdEqual(left, changed), false);
});

test('cloud group read marking patches stale local unread cache rows by session id', () => {
  const groupBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:abc',
    groupSpaceId: 'session:group:abc',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: {
      accountId: 'acct_peer',
      displayName: 'Peer Person',
      avatarUrl: null,
      role: 'person',
    },
    participants: [],
    message: {
      id: 'msg:group-agent-final',
      senderAccountId: 'acct_peer',
      text: 'Hi 👋 How can I help?',
      createdAtMs: Date.parse('2026-05-11T10:00:00Z'),
      senderKind: 'agent',
      senderDisplayName: 'Kordi Project Driver',
    },
  });
  const staleGroupMessage: CloudMessage = {
    ...message,
    messageId: 'msg_group_final',
    body: groupBody,
    sessionId: 'session:group:abc',
  };
  const directUnreadMessage: CloudMessage = {
    ...message,
    messageId: 'msg_direct_unread',
    sessionId: 'session:direct-person:acct_me:acct_peer',
  };

  const patched = markCloudMessagesReadLocally(
    { acct_peer: [staleGroupMessage, directUnreadMessage] },
    'acct_me',
    { sessionIds: ['session:group:abc'] },
    '2026-05-11T10:01:00Z',
  );

  assert.equal(patched.acct_peer?.[0]?.readAt, '2026-05-11T10:01:00Z');
  assert.equal(patched.acct_peer?.[1]?.readAt, null);
});

test('cloud message refresh snapshots preserve locally merged newer messages', () => {
  const greeting: CloudMessage = {
    ...message,
    messageId: 'msg_hello',
    body: 'hello',
  };
  const justSent: CloudMessage = {
    ...message,
    messageId: 'msg_sent',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    direction: 'outgoing',
    body: 'hiho w are you',
    createdAt: '2026-05-11T10:00:05Z',
    deliveredAt: '2026-05-11T10:00:05Z',
    sessionId: 'session:direct-person:acct_me:acct_peer',
  };

  const merged = mergeCloudMessagesByPeerSnapshot(
    { acct_peer: [greeting, justSent] },
    { acct_peer: [greeting] },
  );

  assert.deepEqual(
    merged.acct_peer?.map((item) => item.messageId),
    ['msg_hello', 'msg_sent'],
  );
});

test('canonical conversation sequence wins over timestamps when messages are ordered', () => {
  const sessionId = 'session:direct-person:acct_me:acct_peer';
  const sequenceTwo: CloudMessage = {
    ...message,
    messageId: 'msg_sequence_two',
    sessionId,
    conversationSequence: 2,
    createdAt: '2026-05-11T09:00:00Z',
  };
  const sequenceOne: CloudMessage = {
    ...message,
    messageId: 'msg_sequence_one',
    sessionId,
    conversationSequence: 1,
    createdAt: '2026-05-11T10:00:00Z',
  };

  const merged = mergeCloudMessagesByPeerSnapshot(
    { acct_peer: [sequenceTwo] },
    { acct_peer: [sequenceOne] },
  );

  assert.deepEqual(
    merged.acct_peer?.map((item) => item.messageId),
    ['msg_sequence_one', 'msg_sequence_two'],
  );
});

test('an older entity version cannot replace a newer durable message snapshot', () => {
  const current: CloudMessage = {
    ...message,
    body: 'final durable response',
    version: 3,
    conversationSequence: 1,
  };
  const merged = mergeCloudMessagesByPeerSnapshot(
    { acct_peer: [current] },
    { acct_peer: [{ ...current, body: 'stale partial response', version: 2 }] },
  );

  assert.equal(merged.acct_peer?.[0]?.body, 'final durable response');
  assert.equal(merged.acct_peer?.[0]?.version, 3);
});

test('cloud message snapshot merges cannot clear established read receipts', () => {
  const authoritative: CloudMessage = {
    ...message,
    deliveredAt: '2026-05-11T10:01:00Z',
    readAt: '2026-05-11T10:02:00Z',
  };
  const merged = mergeCloudMessagesByPeerSnapshot(
    { acct_peer: [authoritative] },
    {
      acct_peer: [{
        ...authoritative,
        deliveredAt: null,
        readAt: null,
      }],
    },
  );

  assert.equal(merged.acct_peer?.[0]?.deliveredAt, authoritative.deliveredAt);
  assert.equal(merged.acct_peer?.[0]?.readAt, authoritative.readAt);
});

test('cloud message snapshot merges preserve unchanged peer and message identities', () => {
  const peerOne = [{ ...message, messageId: 'msg_peer_one' }];
  const peerTwo = [{
    ...message,
    messageId: 'msg_peer_two',
    fromAccountId: 'acct_two',
  }];
  const current = { acct_peer: peerOne, acct_two: peerTwo };

  assert.equal(mergeCloudMessagesByPeerSnapshot(current, current), current);

  const merged = mergeCloudMessagesByPeerSnapshot(current, {
    acct_peer: [{ ...peerOne[0] }],
    acct_two: [...peerTwo, { ...peerTwo[0], messageId: 'msg_peer_two_new' }],
  });
  assert.equal(merged.acct_peer, peerOne);
  assert.equal(merged.acct_peer?.[0], peerOne[0]);
  assert.notEqual(merged.acct_two, peerTwo);
});

test('cloud message peer equality detects attachment cache updates', () => {
  const baseMessage: CloudMessage = {
    ...message,
    attachments: [{
      attachmentId: 'att_1',
      name: 'Screenshot.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 68 * 1024,
      localPath: null,
    }],
  };

  assert.equal(cloudMessagesByPeerEqual({ acct_peer: [baseMessage] }, {
    acct_peer: [{
      ...baseMessage,
      attachments: [{
        ...baseMessage.attachments![0]!,
        localPath: '/tmp/kordi-cache/Screenshot.png',
      }],
    }],
  }), false);
});

test('cloud bootstrap peers include the signed-in account for private self-agent restore', () => {
  assert.deepEqual(
    cloudBootstrapPeerIds(account, ['acct_peer'], []),
    ['acct_me', 'acct_peer'],
  );
});

test('cloud unread readiness is scoped to account, generation, peer set, and publication', () => {
  const peerKey = 'acct_me|acct_peer';
  const contextKey = cloudUnreadReadinessContextKey(account.accountId, 4, peerKey);
  const readiness = { status: 'ready' as const, contextKey };

  assert.equal(cloudMessagesAuthoritativeForContext({
    accountId: account.accountId,
    contactsSettled: true,
    generation: 4,
    peerKey,
    readiness,
  }), true);
  assert.equal(cloudUnreadReadyForContext({
    accountId: account.accountId,
    contactsSettled: true,
    generation: 4,
    peerKey,
    readiness,
    publishedContextKey: null,
  }), false);
  assert.equal(cloudUnreadReadyForContext({
    accountId: account.accountId,
    contactsSettled: true,
    generation: 4,
    peerKey,
    readiness,
    publishedContextKey: contextKey,
  }), true);

  for (const mismatch of [
    { accountId: 'acct_other', generation: 4, peerKey },
    { accountId: account.accountId, generation: 5, peerKey },
    {
      accountId: account.accountId,
      generation: 4,
      peerKey: `${peerKey}|acct_discovered`,
    },
  ]) {
    assert.equal(cloudMessagesAuthoritativeForContext({
      ...mismatch,
      contactsSettled: true,
      readiness,
    }), false);
  }

  assert.equal(cloudUnreadStatusForContext({
    accountId: account.accountId,
    contactsSettled: true,
    generation: 4,
    peerKey,
    readiness: { status: 'error', contextKey },
    publishedContextKey: null,
  }), 'error');
});

test('established unread readiness survives same-context errors but not a new context', () => {
  const readyKey = cloudUnreadReadinessContextKey(
    account.accountId,
    2,
    'acct_me|acct_peer',
  );
  const ready = { status: 'ready' as const, contextKey: readyKey };
  assert.equal(transitionCloudUnreadReadiness(ready, 'pending', readyKey), ready);
  assert.equal(transitionCloudUnreadReadiness(ready, 'error', readyKey), ready);

  const expandedKey = cloudUnreadReadinessContextKey(
    account.accountId,
    2,
    'acct_me|acct_peer|acct_discovered',
  );
  assert.deepEqual(transitionCloudUnreadReadiness(ready, 'pending', expandedKey), {
    status: 'pending',
    contextKey: expandedKey,
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveSessionTitle,
  incomingSessionTitleWins,
  isGenericSessionTitle,
  legacySessionTitleFromMessageText,
  optimisticSessionTitle,
  titleSourceFromMetadata,
} from '../src/features/chat/sessionTitlePolicy';
import {
  sessionConversationDisplayTitle,
  sessionDisplayTitle,
  sessionPrefersPersistedTitle,
} from '../src/features/canonical/readModel/conversationMapping';

test('low-information prompts remain temporary until a topic appears', () => {
  for (const value of ['hi', 'hiiii', 'hello!', 'hi, how are you?', 'Hi! How can I help?', 'test', 'test reply 11', '111', '👍🏽', '@MyKordi', '\u4F60\u597D']) {
    assert.equal(deriveSessionTitle(value), null, value);
  }
  assert.equal(sessionDisplayTitle([
    { role: 'user', text: 'hello', timeLabel: '10:00' },
    { role: 'owned-agent', text: 'Hi! How can I help?', timeLabel: '10:00' },
    { role: 'user', text: 'plan the release validation', timeLabel: '10:01' },
  ], 'New chat'), 'Plan the release validation');
});

test('legacy group title fallback ignores punctuation-only messages', () => {
  assert.equal(legacySessionTitleFromMessageText('?'), null);
  assert.equal(legacySessionTitleFromMessageText('...'), null);
  assert.equal(legacySessionTitleFromMessageText('Kordi bug report'), 'Kordi bug report');
});

test('local titles preserve Unicode and remove reply, command, mention, URL, and path noise', () => {
  assert.equal(deriveSessionTitle('which model are you'), 'Model and identity');
  assert.equal(
    deriveSessionTitle('\u4F60\u662F\u8C01\u4F60\u5728\u4F7F\u7528\u4EC0\u4E48\u6A21\u578B'),
    '\u6A21\u578B\u4E0E\u8EAB\u4EFD',
  );
  assert.equal(deriveSessionTitle('@MyKordi help diagnose high Node CPU usage'), 'Diagnose high Node CPU');
  assert.equal(
    deriveSessionTitle('> quoted response\n/retry @MyKordi plan release validation https://example.com /tmp/debug.log'),
    'Plan release validation',
  );
  assert.equal(deriveSessionTitle('```ts\nconsole.log("test")\n```'), null);
  assert.equal(
    deriveSessionTitle('Attached private-report.pdf please diagnose memory usage'),
    'Diagnose memory usage',
  );
  assert.equal(
    deriveSessionTitle('[attachment: private-report.pdf] diagnose memory usage'),
    'Diagnose memory usage',
  );
});

test('attachment-only titles do not leak local filenames', () => {
  assert.equal(deriveSessionTitle('Attached private-report.pdf'), null);
  assert.equal(deriveSessionTitle('Attachment: private-report.pdf'), null);
  assert.equal(optimisticSessionTitle('', [{ kind: 'image', mimeType: 'image/png' }], 'New chat'), 'Image attachment');
  assert.equal(optimisticSessionTitle('', [{ kind: 'file' }], 'New chat'), 'File attachment');
  assert.equal(optimisticSessionTitle('', [{ kind: 'file' }, { kind: 'image' }], 'New chat'), '2 attachments');
});

test('generated titles are capped at 48 graphemes', () => {
  const title = deriveSessionTitle('organize this deliberately very long conversation topic with enough extra words to overflow');
  assert.ok(title);
  assert.ok(Array.from(title).length <= 48);
});

test('title metadata distinguishes persisted sources from placeholders and raw ids', () => {
  assert.equal(titleSourceFromMetadata({ sessionTitleSource: 'manual' }, 'Release plan'), 'manual');
  assert.equal(titleSourceFromMetadata({ sessionTitleSource: 'manual' }, 'hello'), 'manual');
  assert.equal(titleSourceFromMetadata({ titleSource: 'auto' }, 'Release plan'), 'auto');
  assert.equal(titleSourceFromMetadata({ titleSource: 'legacy' }, 'which model are you'), 'placeholder');
  assert.equal(titleSourceFromMetadata({}, 'New chat'), 'placeholder');
  assert.equal(isGenericSessionTitle('session:self-agent:123'), true);
  assert.equal(isGenericSessionTitle('hello'), true);
  assert.equal(isGenericSessionTitle('which model are you'), true);
  assert.equal(isGenericSessionTitle('Release validation plan'), false);
  assert.equal(incomingSessionTitleWins(
    { titleSource: 'manual', titleRevision: 1, updatedAtMs: 10 },
    { titleSource: 'auto', titleRevision: 2, updatedAtMs: 20 },
  ), false);
  assert.equal(incomingSessionTitleWins(
    { titleSource: 'auto', titleRevision: 1, updatedAtMs: 20 },
    { titleSource: 'auto', titleRevision: 2, updatedAtMs: 10 },
  ), true);
  assert.equal(incomingSessionTitleWins(
    { titleSource: 'manual', titleRevision: 3, updatedAtMs: 30, updatedByAccountId: 'acct_z' },
    { titleSource: 'manual', titleRevision: 3, updatedAtMs: 30, updatedByAccountId: 'acct_a' },
  ), true);
  assert.equal(incomingSessionTitleWins(
    { titleSource: 'manual', titleRevision: 3, updatedAtMs: 30, updatedByAccountId: 'acct_a' },
    { titleSource: 'manual', titleRevision: 3, updatedAtMs: 30, updatedByAccountId: 'acct_z' },
  ), false);
  assert.equal(incomingSessionTitleWins(
    { titleSource: 'manual', titleRevision: 3, updatedAtMs: 30 },
    { titleSource: 'manual', titleRevision: 3, updatedAtMs: 30, updatedByAccountId: 'acct_server' },
  ), true);
});

test('authoritative manual titles survive even when their text resembles a greeting', () => {
  const baseSession = {
    id: 'session:self-agent:manual-title',
    kind: 'self-agent',
    title: 'hello',
    status: 'active',
    createdByIdentityId: 'human:me',
    createdAtMs: 1,
    updatedAtMs: 2,
  } as const;
  assert.equal(sessionPrefersPersistedTitle({
    ...baseSession,
    metadata: { sessionTitleSource: 'manual' },
  }), true);
  assert.equal(sessionPrefersPersistedTitle({
    ...baseSession,
    metadata: { sessionTitleSource: 'auto' },
  }), false);
  assert.equal(sessionPrefersPersistedTitle({
    ...baseSession,
    title: 'session:self-agent:raw-id',
    metadata: { sessionTitleSource: 'manual' },
  }), false);
  assert.equal(sessionPrefersPersistedTitle({
    ...baseSession,
    title: 'New session',
    metadata: { sessionTitleSource: 'manual' },
  }), false);
});

test('renamed default agent replaces a stale generic self-agent header', () => {
  const session = {
    id: 'session:self-agent:renamed',
    kind: 'self-agent',
    title: 'Kordi',
    status: 'active',
    createdByIdentityId: 'human:me',
    primaryIdentityId: 'agent:me',
    createdAtMs: 1,
    updatedAtMs: 2,
  } as const;
  assert.equal(sessionConversationDisplayTitle(
    session,
    [{ id: 'agent:me', kind: 'agent', role: 'owned-agent', name: 'Babytang' }],
    [{ role: 'user', text: 'hello', time: '10:00' }],
    session.title,
  ), 'Babytang');
});

test('meaningful persisted group titles remain stable while partial history hydrates', () => {
  const groupSession = {
    id: 'session:group:main',
    kind: 'group',
    title: 'main',
    status: 'active',
    createdByIdentityId: 'human:me',
    createdAtMs: 1,
    updatedAtMs: 2,
    metadata: {
      sessionTitleSource: 'auto',
      customName: 'Research group',
      groupSpaceId: 'group:space',
    },
  } as const;
  const latestWindow = [{
    role: 'user' as const,
    text: '@Alice can you review this?',
    timeLabel: '10:45',
  }];

  assert.equal(sessionPrefersPersistedTitle(groupSession), true);
  assert.equal(sessionConversationDisplayTitle(
    groupSession,
    [],
    latestWindow,
    groupSession.title,
    { preferFallback: sessionPrefersPersistedTitle(groupSession) },
  ), 'main');
});

test('canonical external group titles win over message-derived fallbacks', () => {
  const groupSession = {
    id: 'session:group:external',
    kind: 'group',
    title: 'Mutation Test Group',
    status: 'active',
    createdByIdentityId: 'human:me',
    createdAtMs: 1,
    updatedAtMs: 2,
    metadata: { sessionTitleSource: 'external' },
  } as const;

  assert.equal(sessionPrefersPersistedTitle(groupSession), true);
  assert.equal(sessionConversationDisplayTitle(
    groupSession,
    [],
    [{ role: 'user', text: 'First message fallback', timeLabel: '10:00' }],
    groupSession.title,
    { preferFallback: sessionPrefersPersistedTitle(groupSession) },
  ), 'Mutation Test Group');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveSessionTitle,
  incomingSessionTitleWins,
  isGenericSessionTitle,
  optimisticSessionTitle,
  titleSourceFromMetadata,
} from '../src/features/chat/sessionTitlePolicy';
import {
  sessionDisplayTitle,
  sessionPrefersPersistedTitle,
} from '../src/features/canonical/readModel/conversationMapping';

test('low-information prompts remain temporary until a topic appears', () => {
  for (const value of ['hi', 'hiiii', 'hello!', 'hi, how are you?', 'Hi! How can I help?', 'test', 'test reply 11', '111', '👍🏽', '@MyKordi', '你好']) {
    assert.equal(deriveSessionTitle(value), null, value);
  }
  assert.equal(sessionDisplayTitle([
    { role: 'user', text: 'hello', timeLabel: '10:00' },
    { role: 'owned-agent', text: 'Hi! How can I help?', timeLabel: '10:00' },
    { role: 'user', text: 'plan the release validation', timeLabel: '10:01' },
  ], 'New chat'), 'Plan the release validation');
});

test('local titles preserve Unicode and remove reply, command, mention, URL, and path noise', () => {
  assert.equal(deriveSessionTitle('which model are you'), 'Model and identity');
  assert.equal(deriveSessionTitle('你是谁你在使用什么模型'), '模型与身份');
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

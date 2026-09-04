import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { cloudGroupSessionTitlesForReadModel, patchCanonicalCloudGroupSessionTitles, reliableCloudGroupSessionActivityAtMs, reliableCloudGroupSessionTitleIds } from '../src/features/cloud/cloudCollaborationStateHelpers';

test('reliable group preferences override legacy message-derived titles', () => {
  const titles = cloudGroupSessionTitlesForReadModel(
    {
      'session:group:austin': { title: 'Austin life' },
      'session:direct-person:peer': { title: 'Ignored direct title' },
    },
  );
  const source = readFileSync(
    new URL('../src/features/cloud/useCloudCollaborationState.ts', import.meta.url),
    'utf8',
  );

  assert.equal(titles.get('session:group:austin'), 'Austin life');
  assert.equal(titles.has('session:group:other'), false);
  assert.equal(titles.has('session:direct-person:peer'), false);
  assert.deepEqual(
    [...reliableCloudGroupSessionTitleIds({
      'session:group:austin': { title: 'Austin life' },
      'session:group:blank': { title: ' ' },
      'session:direct-person:peer': { title: 'Ignored direct title' },
    })],
    ['session:group:austin'],
  );
  assert.match(source, /const cloudGroupSessionTitles = useMemo\(\(\) => cloudGroupSessionTitlesForReadModel/);
  const activity = reliableCloudGroupSessionActivityAtMs(new Map([
    ['session:group:austin', [
      { wire: { createdAt: '2026-08-28T07:00:00Z' }, envelope: { kind: 'group-message', message: {} } },
      { wire: { createdAt: '2026-08-28T08:00:00Z' }, envelope: { kind: 'session-title-update' } },
      { wire: { createdAt: '2026-08-28T09:00:00Z' }, envelope: { kind: 'group-message', message: {} } },
      { wire: { createdAt: '2026-08-28T10:00:00Z' }, envelope: { kind: 'session-title-update', sessionTitleSyncOnly: true } },
    ]],
    ['session:group:controls-only', [
      { wire: { createdAt: '2026-08-28T10:00:00Z' }, envelope: { kind: 'group-update' } },
      { wire: { createdAt: '2026-08-28T11:00:00Z' }, envelope: { kind: 'group-title-update' } },
    ]],
  ]) as never);
  assert.equal(activity.get('session:group:austin'), Date.parse('2026-08-28T09:00:00Z'));
  assert.equal(activity.get('session:group:controls-only'), Date.parse('2026-08-28T11:00:00Z'));
});

test('reliable group titles patch placeholder canonical session shells', () => {
  const state = {
    sessions: [{
      id: 'session:group:austin',
      kind: 'group',
      title: 'New chat',
      metadata: { sessionTitleSource: 'placeholder', sessionTitleRevision: 0 },
    }],
  } as never;
  const patched = patchCanonicalCloudGroupSessionTitles(state, {
    'session:group:austin': {
      sessionId: 'session:group:austin',
      title: 'Austin life',
      titleSource: 'external',
      titleRevision: 4,
      titlePolicyVersion: 1,
      titleGeneratedFromMessageId: null,
      updatedAtMs: 123,
      updatedByAccountId: 'acct_owner',
      updatedAt: '2026-08-30T00:00:00Z',
    },
  });

  assert.equal(patched?.sessions[0]?.title, 'Austin life');
  assert.equal(patched?.sessions[0]?.metadata?.sessionTitleSource, 'external');
  assert.equal(patched?.sessions[0]?.metadata?.sessionTitleRevision, 4);
});

test('Cloud group titles replace stale local manual titles', () => {
  const state = {
    sessions: [{
      id: 'session:group:austin',
      kind: 'group',
      title: 'First message used as a title',
      metadata: { sessionTitleSource: 'manual', sessionTitleRevision: 1 },
    }],
  } as never;

  const patched = patchCanonicalCloudGroupSessionTitles(state, {
    'session:group:austin': {
      sessionId: 'session:group:austin',
      title: 'Channel planning',
      titleSource: 'external',
      titleRevision: 5,
      titlePolicyVersion: 1,
      titleGeneratedFromMessageId: null,
      updatedAtMs: 456,
      updatedByAccountId: 'acct_owner',
      updatedAt: '2026-09-03T00:00:00Z',
    },
  });

  assert.equal(patched?.sessions[0]?.title, 'Channel planning');
  assert.equal(patched?.sessions[0]?.metadata?.sessionTitleSource, 'external');
});

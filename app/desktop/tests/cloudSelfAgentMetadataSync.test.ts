import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  releaseCloudSessionTitleUpload,
  reserveCloudSessionTitleUpload,
} from '../src/features/cloud/useCloudSelfAgentMetadataSync';

test('session title upload reservations survive rerenders until the request fails', () => {
  const reservations = new Map<string, string>();

  assert.equal(
    reserveCloudSessionTitleUpload(reservations, 'session:one', 'title:v1'),
    true,
  );
  assert.equal(
    reserveCloudSessionTitleUpload(reservations, 'session:one', 'title:v1'),
    false,
  );

  releaseCloudSessionTitleUpload(reservations, 'session:one', 'older-title');
  assert.equal(reservations.get('session:one'), 'title:v1');

  releaseCloudSessionTitleUpload(reservations, 'session:one', 'title:v1');
  assert.equal(reservations.has('session:one'), false);
  assert.equal(
    reserveCloudSessionTitleUpload(reservations, 'session:one', 'title:v1'),
    true,
  );
});

test('effect cleanup cancels React publication without releasing successful uploads', () => {
  const source = readFileSync(
    new URL(
      '../src/features/cloud/useCloudSelfAgentMetadataSync.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const cleanupStart = source.lastIndexOf('return () => {');
  const cleanupEnd = source.indexOf('};', cleanupStart);
  const cleanup = source.slice(cleanupStart, cleanupEnd + 2);

  assert.match(cleanup, /cancelled = true/);
  assert.doesNotMatch(cleanup, /delete|releaseCloudSessionTitleUpload/);
});

test('title sync includes empty canonical agent sessions instead of depending on message rows', () => {
  const source = readFileSync(
    new URL(
      '../src/features/cloud/useCloudSelfAgentMetadataSync.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(source, /client\.knownChatSessionIds\(account\.accountId\)/);
});

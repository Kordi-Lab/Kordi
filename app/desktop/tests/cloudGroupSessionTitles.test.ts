import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { cloudGroupSessionTitlesForReadModel, reliableCloudGroupSessionActivityAtMs, reliableCloudGroupSessionMessageCounts, reliableCloudGroupSessionTitleIds } from '../src/features/cloud/cloudCollaborationStateHelpers';

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
  assert.equal(reliableCloudGroupSessionActivityAtMs(new Map([
    ['session:group:austin', [
      { wire: { createdAt: '2026-08-28T07:00:00Z' } },
      { wire: { createdAt: '2026-08-28T08:00:00Z' } },
    ]],
  ]) as never).get('session:group:austin'), Date.parse('2026-08-28T08:00:00Z'));
  assert.equal(reliableCloudGroupSessionMessageCounts(new Map([
    ['session:group:austin', [
      { wire: { conversationSequence: 7 } },
      { wire: { conversationSequence: 42 } },
    ]],
  ]) as never).get('session:group:austin'), 42);
});

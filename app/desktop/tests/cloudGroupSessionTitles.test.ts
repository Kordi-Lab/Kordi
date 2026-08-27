import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { cloudGroupSessionTitlesForReadModel } from '../src/features/cloud/cloudCollaborationStateHelpers';

test('reliable group preferences override legacy message-derived titles', () => {
  const titles = cloudGroupSessionTitlesForReadModel(
    new Map([
      ['session:group:austin', 'Legacy first message'],
      ['session:group:other', 'Other legacy title'],
    ]),
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
  assert.equal(titles.get('session:group:other'), 'Other legacy title');
  assert.equal(titles.has('session:direct-person:peer'), false);
  assert.match(source, /const cloudGroupSessionTitles = useMemo\(\(\) => cloudGroupSessionTitlesForReadModel/);
});

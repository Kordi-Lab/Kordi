import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('group rename publishes through every existing channel without creating a new group root', () => {
  const source = readFileSync(
    new URL('../src/app/useKordiGroupRename.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /canonicalState\.sessions\.flatMap/);
  assert.match(source, /for \(const sessionId of groupSessionIdsForGroup\)[\s\S]*await sendCloudGroupControl\([\s\S]*kind: 'group-title-update',[\s\S]*groupId: sessionId,[\s\S]*groupSpaceId: groupId,/);
  assert.doesNotMatch(source, /Promise\.all\(groupSessionIdsForGroup\.map/);
  assert.match(
    source,
    /if \(cloudTargetAccountIds\.length > 0 && account\)[\s\S]*sendCloudGroupControl\([\s\S]*else \{[\s\S]*appendCanonicalRenameNotice/,
    'hosted group renames should render the durable Cloud notice instead of a second local notice',
  );
});

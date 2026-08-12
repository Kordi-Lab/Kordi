import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function readRuntimeSources(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return [readRuntimeSources(path)];
      return /\.(?:ts|tsx)$/.test(entry.name) ? [readFileSync(path, 'utf8')] : [];
    })
    .join('\n');
}

test('desktop chat transport contains no retired v1 message or sync endpoints', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const source = readRuntimeSources(`${root}/src`);
  for (const retired of [
    '/v1/cloud/messages',
    '/v1/cloud/messages/read',
    '/v1/cloud/sync',
    'kordi.cloud.messagesByPeer.v1:',
  ]) {
    assert.equal(source.includes(retired), false, `retired endpoint remains: ${retired}`);
  }
  for (const required of [
    '/v2/chat/conversations',
    '/v2/chat/sync',
    '/v2/chat/sync/bootstrap',
    '/v2/chat/realtime/ticket',
  ]) {
    assert.equal(source.includes(required), true, `chat endpoint missing: ${required}`);
  }
});

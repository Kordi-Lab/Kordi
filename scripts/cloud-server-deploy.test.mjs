import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptPath = new URL('../bridges/cloud-server/deploy/sync-and-build.sh', import.meta.url);

test('cloud server sync preserves remote Cargo target while deleting stale source files', async () => {
  const script = await readFile(scriptPath, 'utf8');

  assert.match(script, /rsync[\s\S]*--delete/);
  assert.match(script, /--exclude=['"]target\/['"]/);
  assert.match(script, /--exclude=['"]\.git\/['"]/);
  assert.match(script, /command -v rsync/);
  assert.match(script, /apt-get install -y rsync/);
  assert.match(script, /RSYNC_REMOTE=/);
  assert.match(script, /--rsh="\$\{RSYNC_RSH\}"/);
  assert.match(script, /"\$\{RSYNC_REMOTE\}:\$\{REMOTE_DIR\}\/"/);
  assert.doesNotMatch(script, /gcloud compute scp/);
  assert.doesNotMatch(script, /rm -rf \$\{REMOTE_DIR\}\.old|mv \$\{REMOTE_DIR\} \$\{REMOTE_DIR\}\.old/);
});

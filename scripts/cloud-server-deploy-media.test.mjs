import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const deployScript = fileURLToPath(
  new URL('../bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh', import.meta.url),
);

// Stands in for gcloud: records each remote command and drains piped input.
const fakeGcloud = `#!/bin/sh
command=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--command" ]; then
    shift
    command="$1"
  fi
  shift
done
cat >/dev/null
printf '%s\\n<<end>>\\n' "$command" >>"$GCLOUD_LOG"
`;

async function runDeploy(environment) {
  const directory = await mkdtemp(join(tmpdir(), 'kordi-deploy-media-'));
  try {
    const log = join(directory, 'gcloud.log');
    await writeFile(join(directory, 'gcloud'), fakeGcloud);
    await chmod(join(directory, 'gcloud'), 0o755);
    await writeFile(log, '');
    const result = spawnSync('bash', [deployScript], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        HOME: directory,
        GCLOUD_LOG: log,
        KORDI_CLOUD_SSH_TARGET: 'synthetic-target',
        KORDI_CLOUD_SSH_ZONE: 'synthetic-zone',
        KORDI_CLOUD_GCP_PROJECT: 'synthetic-project',
        KORDI_CLOUD_IMAGE_TAG: 'synthetic-tag',
        KORDI_VERIFY_PUBLIC_ORIGINS: 'false',
        KORDI_EXPECT_DESKTOP_RELEASE_UNPUBLISHED: 'false',
        ...environment,
      },
    });
    const commands = (await readFile(log, 'utf8')).split('\n<<end>>\n').filter(Boolean);
    return { ...result, commands };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const appliesServer = (command) => /kubectl apply -f -/.test(command) && /cloud-server-deployment\.yaml/.test(command);

test('the default deploy requires the media Secret and applies in-cluster LiveKit', async () => {
  const { status, stderr, commands } = await runDeploy({});
  assert.equal(status, 0, stderr);
  const media = commands.find((command) => command.includes('livekit.yaml'));
  assert.ok(media, 'LiveKit is applied');
  for (const key of ['url', 'api-key', 'api-secret', 'keys']) {
    assert.match(media, new RegExp(`secret kordi-livekit -o jsonpath='\\{\\.data\\.${key}\\}' \\| grep -q \\.`));
  }
  assert.match(media, /rollout status deployment\/livekit/);
  assert.ok(commands.some(appliesServer), 'the Cloud server is applied');
});

test('KORDI_CLUSTER_LIVEKIT=false skips LiveKit and does not require its Secret', async () => {
  const { status, stderr, stdout, commands } = await runDeploy({ KORDI_CLUSTER_LIVEKIT: 'false' });
  assert.equal(status, 0, stderr);
  assert.match(stdout, /skipping in-cluster call media/);
  assert.ok(!commands.some((command) => command.includes('livekit.yaml') && command.includes('kubectl apply')));
  assert.ok(!commands.some((command) => /jsonpath='\{\.data\.[a-z-]+\}' \| grep -q/.test(command) && command.includes('kordi-livekit')));
  assert.ok(!commands.some((command) => command.includes('rollout status deployment/livekit')));
  const media = commands.find((command) => command.includes('scale deployment/livekit --replicas=0'));
  assert.ok(media, 'an existing in-cluster media server is scaled to zero');
  assert.match(media, /if kubectl -n kordi-cloud get deployment\/livekit/);
  assert.ok(commands.some(appliesServer), 'the Cloud server is still applied');
});

test('an unknown KORDI_CLUSTER_LIVEKIT value stops before contacting the host', async () => {
  const { status, stderr, commands } = await runDeploy({ KORDI_CLUSTER_LIVEKIT: 'no' });
  assert.notEqual(status, 0);
  assert.match(stderr, /KORDI_CLUSTER_LIVEKIT must be true or false/);
  assert.deepEqual(commands, []);
});

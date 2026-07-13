import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const requireFromDesktop = createRequire(new URL('../app/desktop/package.json', import.meta.url));
const YAML = requireFromDesktop('yaml');

const minioPath = new URL('../bridges/cloud-server/deploy/k3s/manifests/minio.yaml', import.meta.url);
const serverPath = new URL('../bridges/cloud-server/deploy/k3s/manifests/cloud-server-deployment.yaml', import.meta.url);
const readerPolicyPath = new URL('../bridges/cloud-server/deploy/k3s/policies/kordi-releases-reader.json', import.meta.url);
const publisherPolicyPath = new URL('../bridges/cloud-server/deploy/k3s/policies/kordi-releases-publisher.json', import.meta.url);
const credentialScriptPath = new URL('../bridges/cloud-server/deploy/k3s/create-release-credentials.sh', import.meta.url);
const credentialUtilsPath = new URL('../bridges/cloud-server/deploy/k3s/release-credential-utils.sh', import.meta.url);
const deployScriptPath = new URL('../bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh', import.meta.url);
const ciWorkflowPath = new URL('../.github/workflows/ci.yml', import.meta.url);
const execFileAsync = promisify(execFile);

function policyActions(policy) {
  return policy.Statement.flatMap((statement) => statement.Action);
}

async function createAccessKeyFixture(value) {
  const directory = await mkdtemp(join(tmpdir(), 'kordi-release-access-key-'));
  const path = join(directory, 'access-key');
  await writeFile(path, value);
  await chmod(path, 0o644);
  return { directory, path };
}

async function normalizeAccessKeyFixture(path) {
  return execFileAsync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$1"; normalize_access_key_file "$2"',
      'normalize-access-key-test',
      fileURLToPath(credentialUtilsPath),
      path,
    ],
    { encoding: 'utf8' },
  );
}

test('MinIO bootstrap creates private attachment and release buckets', async () => {
  const source = await readFile(minioPath, 'utf8');
  const documents = YAML.parseAllDocuments(source).map((document) => document.toJSON());
  const job = documents.find((document) => document?.kind === 'Job');
  const command = job.spec.template.spec.containers[0].command.join('\n');

  assert.match(command, /mc mb --ignore-existing local\/kordi-releases/);
  assert.match(command, /mc anonymous set none local\/kordi-releases/);
  assert.match(command, /mc mb --ignore-existing local\/kordi-attachments/);
  assert.doesNotMatch(source, /reader-access-secret|publisher-secret-value|TAURI_SIGNING_PRIVATE_KEY/);
});

test('release policies permit only reads and conditional writes, with no deletion or administration', async () => {
  const reader = JSON.parse(await readFile(readerPolicyPath, 'utf8'));
  const publisher = JSON.parse(await readFile(publisherPolicyPath, 'utf8'));
  const readerActions = policyActions(reader);
  const publisherActions = policyActions(publisher);

  assert.deepEqual(readerActions.sort(), ['s3:GetBucketLocation', 's3:GetObject', 's3:ListBucket'].sort());
  assert.ok(publisherActions.includes('s3:GetObject'));
  assert.ok(publisherActions.includes('s3:PutObject'));
  assert.ok(publisherActions.includes('s3:ListBucket'));
  assert.ok(publisherActions.includes('s3:AbortMultipartUpload'));
  assert.doesNotMatch(publisherActions.join('\n'), /Delete/i);
  assert.doesNotMatch(readerActions.join('\n'), /Delete|Policy|Admin|CreateBucket|PutBucket/i);
  for (const action of publisherActions) {
    assert.doesNotMatch(action, /Policy|Admin|CreateBucket|PutBucket/i);
  }

  const readerResources = reader.Statement.flatMap((statement) => statement.Resource);
  assert.ok(readerResources.every((resource) => resource === 'arn:aws:s3:::kordi-releases' || resource === 'arn:aws:s3:::kordi-releases/*'));
});

test('Cloud deployment uses a dedicated release-reader secret and all release store settings', async () => {
  const source = await readFile(serverPath, 'utf8');
  const documents = YAML.parseAllDocuments(source).map((document) => document.toJSON());
  const deployment = documents.find((document) => document?.kind === 'Deployment');
  const env = deployment.spec.template.spec.containers[0].env;
  const byName = new Map(env.map((entry) => [entry.name, entry]));

  assert.equal(byName.get('KORDI_RELEASE_S3_ENDPOINT').value, 'http://minio.kordi-cloud.svc.cluster.local:9000');
  assert.equal(byName.get('KORDI_RELEASE_S3_BUCKET').value, 'kordi-releases');
  assert.equal(byName.get('KORDI_RELEASE_S3_REGION').value, 'us-east-1');
  assert.equal(byName.get('KORDI_RELEASE_S3_ACCESS_KEY').valueFrom.secretKeyRef.name, 'kordi-release-reader');
  assert.equal(byName.get('KORDI_RELEASE_S3_SECRET_KEY').valueFrom.secretKeyRef.name, 'kordi-release-reader');
  assert.notEqual(byName.get('KORDI_RELEASE_S3_ACCESS_KEY').valueFrom.secretKeyRef.name, byName.get('S3_ACCESS_KEY').valueFrom.secretKeyRef.name);
});

test('credential and deploy scripts provision scoped users without logging credentials and validate storage before rollout', async () => {
  const credentials = await readFile(credentialScriptPath, 'utf8');
  const credentialUtils = await readFile(credentialUtilsPath, 'utf8');
  const deploy = await readFile(deployScriptPath, 'utf8');

  assert.match(credentials, /openssl rand/);
  assert.match(credentials, /source .*release-credential-utils\.sh/);
  assert.match(credentials, /normalize_access_key_file "\$\{reader_access_file\}"/);
  assert.match(credentials, /normalize_access_key_file "\$\{publisher_access_file\}"/);
  assert.match(credentials, /gcloud secrets versions add "kordi-release-publisher-access-key"/);
  assert.match(credentialUtils, /tr -d '\\r\\n'/);
  assert.match(credentialUtils, /chmod 600/);
  assert.match(credentials, /kordi-release-reader/);
  assert.match(credentials, /kordi-release-publisher-access-key/);
  assert.match(credentials, /kordi-release-publisher-secret-key/);
  assert.match(credentials, /mc admin user add/);
  assert.match(credentials, /mc admin policy attach/);
  assert.match(credentials, /kordi-releases-reader/);
  assert.match(credentials, /kordi-releases-publisher/);
  assert.match(credentials, /mc anonymous get/);
  assert.match(credentials, /if mc rm "publisher\/kordi-releases\/\$pointer_probe"/);
  assert.match(credentials, /publisher unexpectedly has pointer delete access/);
  assert.doesNotMatch(credentials, /^\s*mc rm "publisher\/kordi-releases\/\$pointer_probe"/m);
  assert.doesNotMatch(credentials, /echo \"?\$\{?(?:READER|PUBLISHER)_(?:ACCESS|SECRET)/i);

  assert.match(deploy, /kordi-release-reader/);
  assert.match(deploy, /kordi-releases/);
  assert.match(deploy, /rollout status statefulset\/minio/);
  assert.match(deploy, /release-store-check/);
  assert.ok(deploy.indexOf('release-store-check') < deploy.indexOf('rollout status deployment\/kordi-cloud-server'));
  assert.match(deploy, /updates\/desktop\/darwin\/aarch64\/0\.0\.1-beta\.5/);
  assert.match(deploy, /204/);
  assert.match(deploy, /updates\/releases\/version/);
  assert.match(deploy, /downloadUrl/);
  assert.match(deploy, /https:\/\/coordinar\.io\/health/);
});

test('access-key normalization handles LF and CRLF fixtures and locks file permissions', async (t) => {
  const expected = '0123456789abcdef0123456789abcdef';
  for (const suffix of ['\n', '\r\n']) {
    const fixture = await createAccessKeyFixture(`${expected}${suffix}`);
    t.after(() => rm(fixture.directory, { recursive: true, force: true }));

    const result = await normalizeAccessKeyFixture(fixture.path);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(await readFile(fixture.path, 'utf8'), expected);
    assert.equal((await stat(fixture.path)).mode & 0o777, 0o600);
  }
});

test('access-key normalization is idempotent across repeated runs', async (t) => {
  const expected = 'fedcba9876543210fedcba9876543210';
  const fixture = await createAccessKeyFixture(`${expected}\n`);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  await normalizeAccessKeyFixture(fixture.path);
  await normalizeAccessKeyFixture(fixture.path);

  assert.equal(await readFile(fixture.path, 'utf8'), expected);
  assert.equal((await stat(fixture.path)).mode & 0o777, 0o600);
});

test('access-key normalization rejects short input without exposing it', async (t) => {
  const fixture = await createAccessKeyFixture('xy\r\n');
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  await assert.rejects(normalizeAccessKeyFixture(fixture.path), (error) => {
    assert.match(error.stderr, /release access key is invalid/);
    assert.doesNotMatch(error.stderr, /xy/);
    return true;
  });
  assert.equal(await readFile(fixture.path, 'utf8'), 'xy\r\n');
});

test('CI exercises release publisher contracts and the Cloud update server', async () => {
  const workflow = await readFile(ciWorkflowPath, 'utf8');

  assert.match(workflow, /run: pnpm test:scripts/);
  assert.match(workflow, /run: cargo test -p kordi-cloud-server/);
});

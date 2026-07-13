import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const requireFromDesktop = createRequire(new URL('../app/desktop/package.json', import.meta.url));
const YAML = requireFromDesktop('yaml');

const minioPath = new URL('../bridges/cloud-server/deploy/k3s/manifests/minio.yaml', import.meta.url);
const serverPath = new URL('../bridges/cloud-server/deploy/k3s/manifests/cloud-server-deployment.yaml', import.meta.url);
const readerPolicyPath = new URL('../bridges/cloud-server/deploy/k3s/policies/kordi-releases-reader.json', import.meta.url);
const publisherPolicyPath = new URL('../bridges/cloud-server/deploy/k3s/policies/kordi-releases-publisher.json', import.meta.url);
const credentialScriptPath = new URL('../bridges/cloud-server/deploy/k3s/create-release-credentials.sh', import.meta.url);
const deployScriptPath = new URL('../bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh', import.meta.url);
const ciWorkflowPath = new URL('../.github/workflows/ci.yml', import.meta.url);

function policyActions(policy) {
  return policy.Statement.flatMap((statement) => statement.Action);
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

test('release policies allow pointer rollback but never immutable deletion or administration', async () => {
  const reader = JSON.parse(await readFile(readerPolicyPath, 'utf8'));
  const publisher = JSON.parse(await readFile(publisherPolicyPath, 'utf8'));
  const readerActions = policyActions(reader);
  const publisherActions = policyActions(publisher);

  assert.deepEqual(readerActions.sort(), ['s3:GetBucketLocation', 's3:GetObject', 's3:ListBucket'].sort());
  assert.ok(publisherActions.includes('s3:GetObject'));
  assert.ok(publisherActions.includes('s3:PutObject'));
  assert.ok(publisherActions.includes('s3:ListBucket'));
  assert.ok(publisherActions.includes('s3:AbortMultipartUpload'));
  assert.ok(publisherActions.includes('s3:DeleteObject'));
  assert.doesNotMatch(readerActions.join('\n'), /Delete|Policy|Admin|CreateBucket|PutBucket/i);
  for (const action of publisherActions) {
    assert.doesNotMatch(action, /Policy|Admin|CreateBucket|PutBucket/i);
  }

  const deleteStatements = publisher.Statement.filter((statement) =>
    (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes('s3:DeleteObject'),
  );
  assert.deepEqual(deleteStatements, [{
    Effect: 'Allow',
    Action: ['s3:DeleteObject'],
    Resource: ['arn:aws:s3:::kordi-releases/desktop/channels/*/latest.json'],
  }]);

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
  const deploy = await readFile(deployScriptPath, 'utf8');

  assert.match(credentials, /openssl rand/);
  assert.match(credentials, /kordi-release-reader/);
  assert.match(credentials, /kordi-release-publisher-access-key/);
  assert.match(credentials, /kordi-release-publisher-secret-key/);
  assert.match(credentials, /mc admin user add/);
  assert.match(credentials, /mc admin policy attach/);
  assert.match(credentials, /kordi-releases-reader/);
  assert.match(credentials, /kordi-releases-publisher/);
  assert.match(credentials, /mc anonymous get/);
  assert.doesNotMatch(credentials, /echo \"?\$\{?(?:READER|PUBLISHER)_(?:ACCESS|SECRET)/i);

  assert.match(deploy, /kordi-release-reader/);
  assert.match(deploy, /kordi-releases/);
  assert.match(deploy, /rollout status statefulset\/minio/);
  assert.match(deploy, /release-store-check/);
  assert.ok(deploy.indexOf('release-store-check') < deploy.indexOf('rollout status deployment\/kordi-cloud-server'));
});

test('CI exercises release publisher contracts and the Cloud update server', async () => {
  const workflow = await readFile(ciWorkflowPath, 'utf8');

  assert.match(workflow, /run: pnpm test:scripts/);
  assert.match(workflow, /run: cargo test -p kordi-cloud-server/);
});

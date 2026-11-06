import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateDistributionConfiguration, publicClientConfiguration } from '../shared/configuration/distribution.mjs';
import { loadDistributionConfiguration, serviceEnvironment, writeDistributionArtifacts } from '../shared/configuration/distribution-files.mjs';

const fixture = fileURLToPath(new URL('./test_support/distribution/app.json', import.meta.url));
const app = () => JSON.parse(readFileSync(fixture, 'utf8'));
const expected = { edition: 'app', environment: 'production', backendOrigin: 'https://kordi.ai' };
function research() {
  const value = app();
  value.authentication = { admission: 'verified-domain', verifiedDomains: ['example.edu'], approvedEmailsBinding: 'TEST_APPROVED', oauthBindings: { googleClientId: 'TEST_GOOGLE_ID', googleClientSecret: 'TEST_GOOGLE_SECRET', githubClientId: 'TEST_GITHUB_ID', githubClientSecret: 'TEST_GITHUB_SECRET' }, loginPage: {title: 'Research', subtitle: 'Verified email access', signupTitle: 'Join Research', signupSubtitle: 'Verify your email'} };
  value.routing.edition = 'research';
  value.routing.backend.origin = 'https://research.example.test';
  value.resources.provider = 'gcp';
  Object.assign(value.clients, { callbackScheme: 'sample-research', desktopIdentifier: 'test.research.desktop',
    iosIdentifier: 'test.research.ios', iosShareIdentifier: 'test.research.ios.share',
    appGroup: 'group.test.research.share', credentialService: 'test.research.share-session',
    updates: { enabled: false, publicKey: '', artifactName: 'SampleResearch' } });
  return value;
}
const researchTarget = { edition: 'research', environment: 'production', backendOrigin: 'https://research.example.test' };

test('App retains its identity while Research has independent routing, storage and update trust', () => {
  const a = validateDistributionConfiguration(app(), expected);
  const b = validateDistributionConfiguration(research(), researchTarget);
  assert.equal(a.clients.desktopIdentifier, 'io.kordi.cloud');
  assert.equal(a.clients.iosIdentifier, 'ai.kordi.ios');
  for (const key of ['callbackScheme', 'desktopIdentifier', 'iosIdentifier', 'appGroup', 'credentialService']) assert.notEqual(a.clients[key], b.clients[key]);
  assert.equal(b.clients.updates.enabled, false);
  assert.throws(() => validateDistributionConfiguration(app(), researchTarget), /target/);
  assert.throws(() => validateDistributionConfiguration(research(), expected), /target/);
});

test('rejects Beta reuse, missing values, unknown settings and unsafe service selections', () => {
  const mutations = [
    (p) => { p.clients.iosIdentifier = 'ai.kordi.ios.beta'; },
    (p) => { p.clients.callbackScheme = 'kordi-beta'; },
    (p) => { p.resources.cpuLimit = 0; },
    (p) => { p.services.runner.concurrency = 5; },
    (p) => { p.services.runner.sandboxBackend = 'local'; },
    (p) => { p.resources.bindings.project = 'actual-project-value'; },
    (p) => { p.apple.privateKey = 'forbidden'; },
    (p) => { p.clients.desktopIcon = '../escape.png'; },
    (p) => { p.services.systemAgent.persona = ''; },
    (p) => { delete p.clients.updates; },
  ];
  for (const mutation of mutations) { const value = app(); mutation(value); assert.throws(() => validateDistributionConfiguration(value, expected)); }
  const wrong = research(); wrong.clients.appGroup = 'group.ai.kordi.share';
  assert.throws(() => validateDistributionConfiguration(wrong, researchTarget), /namespace/);
});

test('Sign in with Apple bindings are optional and complete when present', () => {
  const withApple = research();
  Object.assign(withApple.authentication.oauthBindings, { appleClientId: 'TEST_APPLE_ID', appleTeamId: 'TEST_APPLE_TEAM', appleKeyId: 'TEST_APPLE_KEY_ID', applePrivateKey: 'TEST_APPLE_KEY' });
  assert.equal(validateDistributionConfiguration(withApple, researchTarget).authentication.oauthBindings.appleClientId, 'TEST_APPLE_ID');
  for (const mutate of [(b) => delete b.appleTeamId, (b) => delete b.applePrivateKey, (b) => { b.appleKeyId = b.appleClientId; }, (b) => { b.appleOther = 'TEST_OTHER'; }, (b) => { b.appleNativeAudiences = 'TEST_AUDIENCES'; }, (b) => { b.toString = 'TEST_PROTO'; }]) {
    const wrong = structuredClone(withApple); mutate(wrong.authentication.oauthBindings);
    assert.throws(() => validateDistributionConfiguration(wrong, researchTarget));
  }
  const encoded = JSON.stringify(publicClientConfiguration(validateDistributionConfiguration(withApple, researchTarget)));
  assert.ok(!encoded.includes('TEST_APPLE'));
});

test('client allowlist excludes service policies, signing references and resource bindings', () => {
  const value = validateDistributionConfiguration(app(), expected);
  const client = publicClientConfiguration(value);
  const encoded = JSON.stringify(client);
  for (const word of ['services', 'resources', 'apple', 'PERSONA', 'APPLE_TEAM_ID', 'Synthetic system']) assert.ok(!encoded.includes(word));
  assert.equal(serviceEnvironment(value, 'runner').KORDI_CLOUD_SANDBOX_BACKEND, 'k8s');
  assert.equal(serviceEnvironment(value, 'server').KORDI_CLOUD_PUBLIC_BASE_URL, expected.backendOrigin);
  assert.equal(serviceEnvironment(value, 'server').KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST, 'kordi://oauth/callback');
});

test('artifact preparation rejects symlink escapes and existing destinations', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'distribution-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selection = loadDistributionConfiguration(fixture, expected);
  const out = writeDistributionArtifacts(selection, path.join(root, 'out'));
  assert.throws(() => writeDistributionArtifacts(selection, out));
  assert.equal(loadDistributionConfiguration(path.join(out, 'profile.json'), expected).profile.routing.backend.origin, expected.backendOrigin);
  const tauri = JSON.parse(readFileSync(path.join(out, 'tauri.json')));
  assert.equal(tauri.identifier, 'io.kordi.cloud');
  assert.equal(tauri.plugins.updater.endpoints[0], 'https://kordi.ai/updates/desktop/{{target}}/{{arch}}/{{current_version}}');
  assert.match(readFileSync(path.join(out, 'ios.xcconfig'), 'utf8'), /https:\/\$\(\)\/kordi.ai/);
  const bad = app(); bad.clients.desktopIcon = 'escape.png';
  writeFileSync(path.join(root, 'bad.json'), JSON.stringify(bad));
  symlinkSync(path.join(path.dirname(fixture), 'fixture.png'), path.join(root, 'escape.png'));
  assert.throws(() => loadDistributionConfiguration(path.join(root, 'bad.json'), expected), /contained/);
});


test('service launcher supplies the selected policy and refuses missing sandbox bindings before execution', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'distribution-process-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'observed.json');
  const env = { ...process.env, KORDI_DISTRIBUTION_PROFILE: fixture,
    KORDI_EXPECTED_EDITION: 'app', KORDI_EXPECTED_ENVIRONMENT: 'production',
    KORDI_EXPECTED_BACKEND_ORIGIN: 'https://kordi.ai' };
  delete env.KORDI_CLOUD_SANDBOX_NAMESPACE;
  delete env.KORDI_CLOUD_SANDBOX_IMAGE;
  const stub = `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({origin: process.env.KORDI_CLOUD_API_BASE, sandbox: process.env.KORDI_CLOUD_SANDBOX_BACKEND, cpu: process.env.KORDI_CLOUD_SANDBOX_CPU_MILLIS}))`;
  const run = () => spawnSync(process.execPath, ['scripts/run-configured-service.mjs', 'runner', process.execPath, '-e', stub, output], { env, encoding: 'utf8' });
  assert.equal(run().status, 1);
  env.KORDI_CLOUD_SANDBOX_NAMESPACE = 'synthetic-runner';
  env.KORDI_CLOUD_SANDBOX_IMAGE = 'registry.example.test/synthetic@sha256:' + 'a'.repeat(64);
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(readFileSync(output)), {origin: expected.backendOrigin, sandbox: 'k8s', cpu: '1000'});
});

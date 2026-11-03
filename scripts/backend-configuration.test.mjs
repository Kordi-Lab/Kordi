import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  CONFIGURATION_SCHEMA_VERSION,
  ConfigurationError,
  legacyBackendEnvironment,
  parseBackendConfiguration,
  validateBackendConfiguration,
} from '../shared/configuration/backend.mjs';
import { backendConfigurationArtifacts } from '../shared/configuration/artifacts.mjs';

const fixture = (edition = 'app', environment = 'production') => ({
  schemaVersion: 1, edition, environment,
  backend: { origin: `https://${edition}.example.test` },
});
const target = (edition = 'app', environment = 'production') => ({
  edition, environment, backendOrigin: `https://${edition}.example.test`,
});

test('both editions and deployment environments validate without an implicit target', () => {
  for (const edition of ['app', 'research']) {
    for (const environment of ['staging', 'production']) {
      const config = fixture(edition, environment);
      assert.deepEqual(parseBackendConfiguration(JSON.stringify(config), target(edition, environment)), config);
    }
  }
  assert.throws(() => validateBackendConfiguration(fixture()), ConfigurationError);
});

test('edition, environment and exact origin must match an independently supplied target', () => {
  const config = fixture();
  for (const expected of [
    target('research'), target('app', 'staging'),
    { ...target(), backendOrigin: 'https://other.example.test' },
  ]) assert.throws(() => validateBackendConfiguration(config, expected), /expected deployment target/);
  assert.throws(() => validateBackendConfiguration(fixture('research'), target()), ConfigurationError);
  assert.throws(() => validateBackendConfiguration({ ...config, edition: 'beta' }, target()), /unsupported edition/);
});

test('unsupported versions, absent fields, credentials and unknown nested fields fail closed', () => {
  const config = fixture();
  for (const value of [
    null, [], '', { ...config, schemaVersion: 2 }, { ...config, schemaVersion: '1' },
    { ...config, schemaVersion: undefined }, { ...config, environment: 'development' },
    { ...config, backend: null }, { ...config, backend: {} },
    { ...config, apiKey: 'synthetic-secret' },
    { ...config, backend: { ...config.backend, token: 'synthetic-secret' } },
    { ...config, features: { bypassAuthorization: true } },
    { ...config, backend: { origin: 123 } },
    JSON.parse('{"schemaVersion":1,"edition":"app","environment":"production","backend":{"origin":"https://app.example.test"},"__proto__":{}}'),
  ]) assert.throws(() => validateBackendConfiguration(value, target()), ConfigurationError);
  for (const field of Object.keys(config)) {
    const missing = { ...config };
    delete missing[field];
    assert.throws(() => validateBackendConfiguration(missing, target()), ConfigurationError);
  }
});

test('only canonical HTTPS DNS origins can enter generated configuration', () => {
  for (const origin of [
    '', ' https://app.example.test', 'https://app.example.test/', 'https://app.example.test:443',
    'HTTPS://app.example.test', 'https://APP.example.test', 'https://app.example.test.',
    'http://app.example.test', 'file:///example', 'https://app.example.test/path',
    'https://app.example.test?token=synthetic-secret', 'https://app.example.test#fragment',
    'https://user:synthetic-secret@app.example.test', 'https://127.0.0.1', 'https://[::1]',
    'https://2130706433', 'https://localhost', 'https://app.localhost', 'https://app.internal',
    'https://app.local', 'https://app..test', 'https://-app.example.test', 'https://app_.test',
    'https://app.example.test\nINJECTED=value', 'https://$(command).example.test',
    `https://${'x'.repeat(64)}.example.test`, `https://${'x'.repeat(2048)}.test`,
  ]) {
    assert.throws(() => validateBackendConfiguration({ ...fixture(), backend: { origin } }, target()), ConfigurationError);
  }
  const origin = 'https://stage.example.test:8443';
  assert.equal(validateBackendConfiguration({ ...fixture(), backend: { origin } }, {
    ...target(), backendOrigin: origin,
  }).backend.origin, origin);
});

test('untrusted accessors are rejected and validated results cannot be mutated through input', () => {
  const config = fixture();
  const result = validateBackendConfiguration(config, target());
  config.backend.origin = 'https://changed.example.test';
  assert.equal(result.backend.origin, target().backendOrigin);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.backend));
  assert.throws(() => validateBackendConfiguration(Object.create(fixture()), target()), ConfigurationError);
  const accessor = fixture();
  Object.defineProperty(accessor, 'backend', { get() { throw new Error('getter executed'); } });
  assert.throws(() => validateBackendConfiguration(accessor, target()), /data fields/);
});

test('invalid JSON and error messages do not disclose candidate contents', () => {
  for (const text of ['synthetic-secret', '{"secret":"synthetic-secret"}', 'x'.repeat(16_385)]) {
    assert.throws(() => parseBackendConfiguration(text, target()), (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.doesNotMatch(error.message, /synthetic-secret/);
      return true;
    });
  }
});

test('adapter exports only existing backend variables and never supplies defaults', () => {
  const env = legacyBackendEnvironment(fixture(), target());
  assert.deepEqual(env, {
    VITE_KORDI_CLOUD_API_BASE: target().backendOrigin,
    KORDI_CLOUD_API_BASE: target().backendOrigin,
  });
  assert.throws(() => legacyBackendEnvironment(undefined, target()), ConfigurationError);
  assert.throws(() => legacyBackendEnvironment(fixture('research'), target()), ConfigurationError);
  assert.equal(Object.keys(env).length, 2);
});

test('artifacts are deterministic and hash the validated allowlisted configuration', () => {
  const config = fixture('research');
  const expected = target('research');
  const artifacts = backendConfigurationArtifacts(config, expected);
  const reordered = { backend: config.backend, environment: config.environment, edition: config.edition, schemaVersion: 1 };
  assert.deepEqual(artifacts, backendConfigurationArtifacts(reordered, expected));
  assert.deepEqual(Object.keys(artifacts), ['backend.json', 'desktop.env', 'runner.env', 'manifest.json']);
  assert.equal(artifacts['desktop.env'], `VITE_KORDI_CLOUD_API_BASE=${expected.backendOrigin}\n`);
  assert.equal(artifacts['runner.env'], `KORDI_CLOUD_API_BASE=${expected.backendOrigin}\n`);
  const manifest = JSON.parse(artifacts['manifest.json']);
  assert.equal(manifest.configurationSha256, createHash('sha256').update(artifacts['backend.json']).digest('hex'));
  assert.equal(manifest.scope, 'backend-routing-only');
  assert.equal(manifest.edition, 'research');
});

test('published schema and synthetic examples match the reference contract', () => {
  const schema = JSON.parse(readFileSync(new URL('../shared/configuration/backend.schema.json', import.meta.url)));
  assert.equal(schema.properties.schemaVersion.const, CONFIGURATION_SCHEMA_VERSION);
  assert.deepEqual(schema.required, Object.keys(fixture()));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.backend.additionalProperties, false);
  assert.deepEqual(schema.properties.edition.enum, ['app', 'research']);
  for (const edition of schema.properties.edition.enum) {
    const text = readFileSync(new URL(`../shared/configuration/examples/${edition}.example.json`, import.meta.url), 'utf8');
    assert.deepEqual(parseBackendConfiguration(text, target(edition)), fixture(edition));
  }
});

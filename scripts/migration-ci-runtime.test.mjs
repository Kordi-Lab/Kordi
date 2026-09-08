import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('migration CI prepares private PostgreSQL without changing runner isolation', () => {
  const workflow = read('../.github/workflows/ci.yml');
  assert.ok(workflow.indexOf('bash scripts/prepare-ci-postgres.sh') < workflow.indexOf('bash scripts/test-cloud-migrations.sh'));
  assert.doesNotMatch(workflow, /runs-on:\s*(?:ubuntu|macos)-latest/);
  assert.match(workflow, /Test database upgrade compatibility\s+run: bash scripts\/test-cloud-migrations.sh/);
});

test('PostgreSQL preparation pins its source and stays unprivileged', () => {
  const source = read('./prepare-ci-postgres.sh');
  execFileSync('bash', ['-n', fileURLToPath(new URL('./prepare-ci-postgres.sh', import.meta.url))]);
  assert.match(source, /version=16\.14/);
  assert.match(source, /checksum=f6d077142737920858ce958ccdb75c6ee137a63b5b0853c70693d401ac7e3471/);
  assert.match(source, /shasum -a 256 --check/);
  assert.match(source, /mktemp -d/);
  assert.match(source, /umask 077/);
  assert.match(source, /KORDI_MIGRATION_PG_BIN/);
  assert.doesNotMatch(source, /\bsudo\b|chmod\s+777|curl[^\n]*--insecure/);
});

test('migration matrix retains explicit ignored fixtures and serialized runtime integration', () => {
  const source = read('./test-cloud-migrations.sh');
  execFileSync('bash', ['-n', fileURLToPath(new URL('./test-cloud-migrations.sh', import.meta.url))]);
  assert.match(source, /-- --ignored --exact/);
  assert.match(source, /--test cloud_agent_runtime_e2e --test chat_sync_e2e -- --test-threads=1/);
  for (const version of ['75', 'digest_76', '88']) assert.ok(source.includes(`upgrade_from_${version}`));
  assert.ok(source.includes('multiple_live_executors_require_drain_without_losing_history'));
  assert.ok(source.includes('upgrade_from_89_repairs_only_proven_defaults_and_authenticated_titles'));
});

test('native migration fixtures cannot connect to an inherited database or public listener', () => {
  const source = read('./test-cloud-migrations.sh');
  const native = read('./lib/native-migration-postgres.sh');
  execFileSync('bash', ['-n', fileURLToPath(new URL('./lib/native-migration-postgres.sh', import.meta.url))]);
  assert.match(source, /unset DATABASE_URL KORDI_MIGRATION_TEST_DATABASE_URL/);
  assert.match(source, /unset PGHOST PGHOSTADDR PGPORT/);
  assert.match(source, /trap cleanup EXIT/);
  assert.match(native, /listen_addresses=''/);
  assert.match(native, /unix_socket_permissions=0700/);
  assert.match(native, /--auth-local=trust --auth-host=reject/);
  assert.match(native, /migration_pg_owned \|\| return 1\s+rm -rf -- "\$migration_cluster"/);
  assert.match(native, /-O "\$migration_cluster" && ! -L "\$migration_cluster"/);
});

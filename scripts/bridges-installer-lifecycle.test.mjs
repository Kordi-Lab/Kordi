import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const commonInstaller = join(repoRoot, 'bridges/scripts/install-bridges-linux-common.sh');
const caddyInstaller = join(repoRoot, 'bridges/scripts/install-bridges-linux-generic.sh');
const nginxInstaller = join(repoRoot, 'bridges/scripts/install-bridges-linux-generic-nginx.sh');

async function fakeLinuxPath() {
  const root = await mkdtemp(join(tmpdir(), 'kordi-installer-test-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  for (const command of ['apt-get', 'sudo', 'systemctl']) {
    const path = join(bin, command);
    await writeFile(path, '#!/usr/bin/env bash\nexit 0\n');
    await chmod(path, 0o755);
  }
  return { root, bin };
}

function runDryInstaller(script, args, bin, extraEnv = {}) {
  const result = spawnSync('bash', [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      CADDY_VERSION: '2.10.0',
      HOME: tmpdir(),
      PATH: `${bin}:${process.env.PATH}`,
      SUDO_USER: '',
      USER: 'kordi-installer-test',
    },
  });
  assert.equal(
    result.status,
    0,
    `${script} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return `${result.stdout}\n${result.stderr}`;
}

function packageInstallLine(output) {
  return output.split('\n').find((line) => line.includes('apt-get install -y')) ?? '';
}

test('all installer shell entrypoints pass Bash syntax validation', () => {
  const result = spawnSync('bash', ['-n', commonInstaller, caddyInstaller, nginxInstaller], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('Caddy and Nginx entrypoints source one Bridges lifecycle implementation', async () => {
  const [common, caddy, nginx] = await Promise.all([
    readFile(commonInstaller, 'utf8'),
    readFile(caddyInstaller, 'utf8'),
    readFile(nginxInstaller, 'utf8'),
  ]);

  assert.match(common, /build_and_install_bridges\(\)/);
  assert.match(common, /write_bridges_service\(\)/);
  assert.match(common, /build_firewall_hints\(\)/);
  for (const entrypoint of [caddy, nginx]) {
    assert.match(entrypoint, /source "\$\{INSTALLER_DIR\}\/install-bridges-linux-common\.sh"/);
    assert.doesNotMatch(entrypoint, /build_and_install_bridges\(\)/);
    assert.doesNotMatch(entrypoint, /write_bridges_service\(\)/);
    assert.doesNotMatch(entrypoint, /build_firewall_hints\(\)/);
  }
});

test('shared package installation preserves every supported distro command', async (t) => {
  const { root, bin } = await fakeLinuxPath();
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectations = new Map([
    ['apt', ['apt-get update', 'xz-utils', 'libssl-dev']],
    ['dnf', ['dnf install -y', 'pkgconf-pkg-config', 'openssl-devel']],
    ['yum', ['yum install -y', 'pkgconfig', 'openssl-devel']],
    ['pacman', ['pacman -Sy --noconfirm --needed', 'base-devel', 'openssl']],
    ['zypper', ['zypper --non-interactive install', 'pkg-config', 'libopenssl-devel']],
  ]);

  for (const [manager, fragments] of expectations) {
    const result = spawnSync('bash', [
      '-c',
      'set -euo pipefail; DRY_RUN=1; source "$1"; install_bridges_packages "$2" unsupported nginx certbot',
      'installer-test',
      commonInstaller,
      manager,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
    assert.equal(result.status, 0, `${manager} failed: ${result.stderr}`);
    for (const fragment of [...fragments, 'nginx', 'certbot']) {
      assert.match(result.stdout, new RegExp(fragment.replaceAll('-', '\\-')));
    }
  }
});

test('shared local health check still fails closed when Bridges is unreachable', () => {
  const result = spawnSync('bash', [
    '-c',
    'set -euo pipefail; DRY_RUN=0; BRIDGES_PORT=17080; source "$1"; sleep() { :; }; curl() { return 42; }; begin_bridges_health_checks',
    'installer-test',
    commonInstaller,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 42);
  assert.match(result.stdout, /Checking local Bridges health/);
});

test('Caddy dry run keeps proxy-specific packages and services out of the shared base install', async (t) => {
  const { root, bin } = await fakeLinuxPath();
  t.after(() => rm(root, { recursive: true, force: true }));

  const output = runDryInstaller(caddyInstaller, [
    '--domain', 'bridge.example.test',
    '--install-dir', '/srv/bridges',
    '--port', '18080',
    '--skip-build',
    '--dry-run',
  ], bin);
  const installLine = packageInstallLine(output);

  assert.match(installLine, /libssl-dev/);
  assert.doesNotMatch(installLine, /\bnginx\b|\bcertbot\b/);
  assert.match(output, /WorkingDirectory=\/srv\/bridges/);
  assert.match(output, /serve --port 18080 --db \/srv\/bridges\/data\/bridges-server\.db/);
  assert.match(output, /systemctl enable --now caddy/);
});

test('Nginx dry runs add only the requested TLS packages to the same base install', async (t) => {
  const { root, bin } = await fakeLinuxPath();
  t.after(() => rm(root, { recursive: true, force: true }));

  const withoutCertificate = runDryInstaller(nginxInstaller, [
    '--domain', 'bridge.example.test',
    '--skip-build',
    '--skip-cert',
    '--dry-run',
  ], bin);
  const withCertificate = runDryInstaller(nginxInstaller, [
    '--domain', 'bridge.example.test',
    '--email', 'admin@example.test',
    '--skip-build',
    '--dry-run',
  ], bin);

  assert.match(packageInstallLine(withoutCertificate), /\bnginx\b/);
  assert.doesNotMatch(packageInstallLine(withoutCertificate), /\bcertbot\b/);
  assert.match(packageInstallLine(withCertificate), /\bnginx\b.*\bcertbot\b/);
  assert.match(withoutCertificate, /systemctl enable --now nginx/);
  assert.match(withCertificate, /certbot certonly --webroot/);
});

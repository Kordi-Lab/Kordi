import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('self-hosted debug stack is loopback-only and production-independent', () => {
  const compose = read('deploy/dev/compose.yaml');

  for (const service of [
    'postgres',
    'redis',
    'nats',
    'minio',
    'minio-init',
    'cloud-server',
    'cloud-agent-runner',
  ]) {
    assert.match(compose, new RegExp(`^  ${service}:`, 'm'));
  }
  assert.match(compose, /127\.0\.0\.1:\$\{KORDI_DEBUG_API_PORT:-17081\}:17081/);
  assert.match(compose, /127\.0\.0\.1:\$\{KORDI_DEBUG_MINIO_PORT:-19000\}:9000/);
  assert.doesNotMatch(compose, /https:\/\/kordi\.ai|KORDI_CLOUD_SSH_TARGET|KORDI_CLOUD_GCP_PROJECT/i);
  assert.doesNotMatch(compose, /^\s*-\s*"?(?:5432|6379|4222):/m);
  assert.match(compose, /KORDI_OAUTH_GITHUB_CLIENT_ID: \$\{KORDI_OAUTH_GITHUB_CLIENT_ID:-\}/);
  assert.match(compose, /KORDI_OAUTH_GOOGLE_CLIENT_ID: \$\{KORDI_OAUTH_GOOGLE_CLIENT_ID:-\}/);
  assert.match(compose, /KORDI_LIVEKIT_URL: \$\{KORDI_LIVEKIT_URL:-\}/);
  assert.match(compose, /KORDI_LIVEKIT_API_KEY: \$\{KORDI_LIVEKIT_API_KEY:-\}/);
  assert.match(compose, /KORDI_LIVEKIT_API_SECRET: \$\{KORDI_LIVEKIT_API_SECRET:-\}/);
  assert.match(compose, /kordi-beta:\/\/oauth\/callback/);
  assert.doesNotMatch(compose, /KORDI_CHAT_SYNC_V2_ENABLED|CHAT_SYNC_V2_DISABLED/);
  assert.match(compose, /KORDI_CLOUD_API_BASE: http:\/\/cloud-server:17081/);
  assert.match(
    compose,
    /KORDI_CHAT_REALTIME_ALLOWED_ORIGINS: "tauri:\/\/localhost,http:\/\/tauri\.localhost,http:\/\/127\.0\.0\.1"/,
  );
  assert.match(compose, /KORDI_CLOUD_SANDBOX_BACKEND: local/);
  assert.match(compose, /KORDI_SUPPORT_ENABLED: "false"/);
});

test('debug environment template contains placeholders instead of usable credentials', () => {
  const template = read('deploy/dev/.env.example');

  assert.match(template, /POSTGRES_PASSWORD=<generated-by-debug-helper>/);
  assert.match(template, /MINIO_ROOT_PASSWORD=<generated-by-debug-helper>/);
  assert.match(template, /KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY=<generated-by-debug-helper>/);
  assert.match(template, /KORDI_CHAT_SYNC_CURSOR_SECRET=<generated-by-debug-helper>/);
  assert.match(template, /KORDI_OAUTH_GITHUB_CLIENT_ID=\n/);
  assert.match(template, /KORDI_OAUTH_GOOGLE_CLIENT_ID=\n/);
  assert.doesNotMatch(template, /https:\/\/kordi\.ai|KORDI_CLOUD_SSH_TARGET|KORDI_CLOUD_GCP_PROJECT/i);
});

test('debug setup removes a temporary credential file when generation is interrupted', () => {
  const helper = read('scripts/dev-cloud-up.sh');
  const gitignore = read('.gitignore');
  const dockerignore = read('.dockerignore');

  assert.match(helper, /trap 'rm -f "\$temp_env"' EXIT/);
  assert.match(helper, /mv "\$temp_env" "\$env_file"\n\s*trap - EXIT/);
  assert.match(gitignore, /deploy\/dev\/\.env\.\?\?\?\?\?\?/);
  assert.match(dockerignore, /deploy\/dev\/\.env\.\?\?\?\?\?\?/);
});

test('debug setup upgrades old env files and rejects parent-shell credential overrides', () => {
  const helper = read('scripts/dev-cloud-up.sh');

  assert.match(helper, /grep -q '\^KORDI_CHAT_SYNC_CURSOR_SECRET='/);
  assert.match(helper, /Added an isolated chat-sync secret/);
  assert.match(helper, /unset POSTGRES_PASSWORD REDIS_PASSWORD/);
  assert.match(helper, /unset KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY KORDI_CLOUD_RUNNER_TOKEN/);
  assert.match(helper, /unset KORDI_OAUTH_GITHUB_CLIENT_ID KORDI_OAUTH_GITHUB_CLIENT_SECRET/);
  assert.match(helper, /unset KORDI_OAUTH_GOOGLE_CLIENT_ID KORDI_OAUTH_GOOGLE_CLIENT_SECRET/);
  assert.doesNotMatch(helper, /pnpm dev"/);
  assert.match(helper, /KORDI_DEBUG_PROJECT_NAME:-kordi-debug/);
  assert.match(helper, /KORDI_DEBUG_ENV_FILE:-\$repo_root\/deploy\/dev\/\.env/);
  assert.match(helper, /--project-name "\$project_name"/);
});

test('debug smoke reports OAuth readiness and a copyable isolated desktop command', () => {
  const smoke = read('scripts/dev-cloud-smoke.sh');

  assert.match(smoke, /\$\{provider\} OAuth: configured/);
  assert.match(smoke, /tr '\[:upper:\]' '\[:lower:\]'/);
  assert.match(smoke, /pnpm debug:cloud:oauth -- \$\{provider_command\}/);
  assert.match(smoke, /VITE_KORDI_CLOUD_API_BASE=\$\{health_url%\/health\}/);
  assert.match(smoke, /--profile dev-isolated/);
  assert.match(smoke, /KORDI_DEBUG_PROJECT_NAME:-kordi-debug/);
  assert.match(smoke, /--project-name "\$project_name"/);
});

test('OAuth helper hides secrets and only restarts isolated app services', () => {
  const helper = read('scripts/dev-cloud-oauth-configure.sh');
  const packageJson = read('package.json');
  const guide = read('docs/self-hosted-debug.md');

  assert.match(helper, /\[\[ ! -t 0 \|\| ! -t 1 \]\]/);
  assert.match(helper, /read -rs client_secret/);
  assert.match(helper, /--from-stdin/);
  assert.match(helper, /Credential input contains an unexpected entry/);
  assert.match(helper, /mktemp "\$repo_root\/deploy\/dev\/\.env\.XXXXXX"/);
  assert.match(helper, /chmod 600 "\$temp_env"\n+mv "\$temp_env" "\$env_file"/);
  assert.match(helper, /unset client_id client_secret/);
  assert.match(helper, /--no-deps cloud-server cloud-agent-runner/);
  assert.doesNotMatch(helper, /kordi\.ai|kordi-product/i);
  assert.match(packageJson, /"debug:cloud:oauth": "bash scripts\/dev-cloud-oauth-configure\.sh"/);
  assert.match(guide, /pnpm debug:cloud:oauth -- github/);
  assert.match(guide, /hidden terminal prompt/);
});

test('self-hosted guide uses the safe helper and explicit loopback API origin', () => {
  const guide = read('docs/self-hosted-debug.md');

  assert.match(guide, /pnpm debug:cloud:up/);
  assert.match(guide, /VITE_KORDI_CLOUD_API_BASE=http:\/\/127\.0\.0\.1:17081/);
  assert.match(guide, /never copies production data/i);
  assert.match(guide, /production access is controlled by server-side IAM/i);
  assert.match(guide, /pnpm debug:cloud:smoke/);
  assert.match(guide, /pnpm dev:cloud:multi -- --reset --users user1,user2/);
  assert.match(guide, /pnpm debug:cloud:reset -- --yes/);
  assert.match(guide, /pnpm check:ci/);
  assert.match(guide, /development-environments\.md#remote-isolated-backend-through-iap/);
  assert.match(guide, /pnpm check:english/);
  assert.doesNotMatch(guide, /127\.0\.0\.1:7890/);
});

test('call hosting guide covers development and product media readiness', () => {
  const guide = read('docs/call-hosting.md');

  for (const value of [
    'KORDI_LIVEKIT_URL',
    'KORDI_LIVEKIT_API_KEY',
    'KORDI_LIVEKIT_API_SECRET',
    'Kordi call media is configured',
    'hostNetwork: true',
    'CALL_MEDIA_UNAVAILABLE',
    'Required two-account acceptance test',
  ]) {
    assert.match(guide, new RegExp(value));
  }
  assert.match(guide, /-L 127\.0\.0\.1:17880:127\.0\.0\.1:7880/);
  assert.match(guide, /-L 127\.0\.0\.1:17881:127\.0\.0\.1:17881/);
  for (const path of [
    'docs/development-environments.md',
    'docs/hosted-cloud-developer-guide.md',
    'docs/development.md',
    'docs/run-cloud-desktop.md',
    'app/desktop/README.md',
    'docs/release.md',
    'docs/development/macos-desktop-release-runbook.md',
    'docs/ios-development.md',
  ]) {
    assert.match(read(path), /call-hosting\.md/, `${path} should link the call hosting guide`);
  }
});

test('public contributor entrypoints lead to the isolated development workflow', () => {
  for (const path of [
    'README.md',
    'CONTRIBUTING.md',
    'docs/community-contributor-guide.md',
    'docs/run-cloud-desktop.md',
  ]) {
    const document = read(path);
    assert.match(document, /pnpm debug:cloud:up/, `${path} should start the isolated backend`);
    assert.match(
      document,
      /VITE_KORDI_CLOUD_API_BASE=http:\/\/127\.0\.0\.1:17081/,
      `${path} should use the loopback API`,
    );
    assert.match(document, /self-hosted-debug\.md/, `${path} should link the full local guide`);
  }

  assert.doesNotMatch(
    read('README.md'),
    /uses the production hosted API at `https:\/\/kordi\.ai` by default/i,
  );
});

test('community guide routes contributors through issues and reviewed pull requests', () => {
  const guide = read('docs/community-contributor-guide.md');

  assert.match(guide, /github\.com\/Kordi-AI\/Kordi\/issues/);
  assert.match(guide, /Normal community contributions do not require production SSH/i);
  assert.match(guide, /Open a draft pull request early/i);
  assert.match(guide, /Do not include tokens, credentials, private infrastructure details/i);
  assert.match(guide, /pnpm check:ci/);
});

test('operator debug ships only a sanitized allowlist example', () => {
  const allowlist = read('deploy/dev/operator-github-allowlist.example.txt')
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);

  assert.deepEqual(allowlist, ['example-maintainer']);
});

test('isolated desktop profiles initialize native Cloud account storage', () => {
  const profile = `storage-test-${process.pid}`;
  const port = '1499';
  const scriptPath = join(repoRoot, 'app', 'desktop', 'scripts', 'tauri-dev-profile.mjs');
  const generatedConfigPath = join(
    repoRoot,
    'app',
    'desktop',
    'src-tauri',
    '.tauri-dev',
    `${profile}-${port}.json`,
  );
  const env = {
    ...process.env,
    VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:17081',
    VITE_KORDI_DEV_PROFILE: 'community',
  };

  try {
    const generated = spawnSync(
      process.execPath,
      [scriptPath, '--dry-run', '--profile', profile, '--port', port],
      { cwd: repoRoot, env, encoding: 'utf8' },
    );
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(
      generated.stdout,
      new RegExp(`"identifier": "io\\.kordi\\.cloud\\.${profile}"`),
    );
    const generatedConfig = JSON.parse(readFileSync(generatedConfigPath, 'utf8'));
    assert.equal(generatedConfig.bundle.createUpdaterArtifacts, false);
    assert.deepEqual(generatedConfig.plugins?.updater?.endpoints, []);
    assert.doesNotMatch(
      JSON.stringify(generatedConfig),
      /https:\/\/kordi\.ai/i,
      'isolated dev profiles must not retain a production updater endpoint',
    );

    const rejected = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--dry-run',
        '--profile',
        profile,
        '--port',
        port,
        '--identifier',
        `io.kordi.desktop.${profile}`,
      ],
      { cwd: repoRoot, env, encoding: 'utf8' },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /must use a unique io\.kordi\.cloud/i);

    const productionIdentifier = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--dry-run',
        '--profile',
        profile,
        '--port',
        port,
        '--identifier',
        'io.kordi.cloud',
      ],
      { cwd: repoRoot, env, encoding: 'utf8' },
    );
    assert.notEqual(productionIdentifier.status, 0);
    assert.match(productionIdentifier.stderr, /unique io\.kordi\.cloud/i);
  } finally {
    rmSync(generatedConfigPath, { force: true });
  }
});

test('operator debug launcher rejects other GitHub accounts and exports no database credentials', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'kordi-operator-test-'));
  const binDir = join(tempRoot, 'bin');
  const capturePath = join(tempRoot, 'capture.txt');
  const allowlistPath = join(tempRoot, 'operator-github-allowlist.txt');
  const scriptPath = join(repoRoot, 'scripts', 'dev-cloud-operator.sh');
  try {
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$TEST_GITHUB_LOGIN"\n');
    writeFileSync(
      join(binDir, 'pnpm'),
      '#!/bin/sh\nprintf \'%s\\n\' "$VITE_KORDI_CLOUD_API_BASE|$VITE_KORDI_DEV_PROFILE|$VITE_KORDI_PRODUCTION_DEBUG_ACK|${DATABASE_URL:-}|${REDIS_URL:-}|${S3_SECRET_KEY:-}|${KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY:-}|${KORDI_OAUTH_GOOGLE_CLIENT_SECRET:-}" > "$TEST_OPERATOR_CAPTURE"\n',
    );
    chmodSync(join(binDir, 'gh'), 0o755);
    chmodSync(join(binDir, 'pnpm'), 0o755);
    writeFileSync(allowlistPath, 'example-maintainer\n');

    const baseEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      KORDI_OPERATOR_DEBUG_ACKNOWLEDGED: '1',
      KORDI_OPERATOR_GITHUB_ALLOWLIST_FILE: allowlistPath,
      TEST_OPERATOR_CAPTURE: capturePath,
      DATABASE_URL: 'postgresql://must-not-reach-desktop',
      REDIS_URL: 'redis://must-not-reach-desktop',
      S3_SECRET_KEY: 'must-not-reach-desktop',
      KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY: 'must-not-reach-desktop',
      KORDI_OAUTH_GOOGLE_CLIENT_SECRET: 'must-not-reach-desktop',
    };
    const rejected = spawnSync('bash', [scriptPath, 'https://kordi.ai'], {
      cwd: repoRoot,
      env: { ...baseEnv, TEST_GITHUB_LOGIN: 'not-allowlisted' },
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /is not allowlisted/i);

    const unapprovedOrigin = spawnSync('bash', [scriptPath, 'https://staging.example.test'], {
      cwd: repoRoot,
      env: { ...baseEnv, TEST_GITHUB_LOGIN: 'example-maintainer' },
      encoding: 'utf8',
    });
    assert.notEqual(unapprovedOrigin.status, 0);
    assert.match(unapprovedOrigin.stderr, /accepts only https:\/\/kordi\.ai/i);

    const allowed = spawnSync('bash', [scriptPath, 'https://kordi.ai'], {
      cwd: repoRoot,
      env: { ...baseEnv, TEST_GITHUB_LOGIN: 'example-maintainer' },
      encoding: 'utf8',
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(
      readFileSync(capturePath, 'utf8').trim(),
      'https://kordi.ai|operator|1|||||',
    );

    const allowedWithSeparator = spawnSync(
      'bash',
      [scriptPath, '--', 'https://kordi.ai', '--port', '1492'],
      {
        cwd: repoRoot,
        env: { ...baseEnv, TEST_GITHUB_LOGIN: 'example-maintainer' },
        encoding: 'utf8',
      },
    );
    assert.equal(allowedWithSeparator.status, 0, allowedWithSeparator.stderr);
    assert.equal(
      readFileSync(capturePath, 'utf8').trim(),
      'https://kordi.ai|operator|1|||||',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('remote development launcher binds the IAP tunnel and desktop to one verified lifecycle', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'kordi-remote-dev-test-'));
  const binDir = join(tempRoot, 'bin');
  const allowlistPath = join(tempRoot, 'operator-github-allowlist.txt');
  const tunnelReadyPath = join(tempRoot, 'tunnel-ready');
  const tunnelAttemptPath = join(tempRoot, 'tunnel-attempt');
  const gcloudCapturePath = join(tempRoot, 'gcloud.txt');
  const desktopCapturePath = join(tempRoot, 'desktop.txt');
  const scriptPath = join(repoRoot, 'scripts', 'dev-cloud-remote.sh');
  try {
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$TEST_GITHUB_LOGIN"\n');
    writeFileSync(
      join(binDir, 'gcloud'),
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" > "$TEST_GCLOUD_CAPTURE"\n: > "$TEST_TUNNEL_READY"\nif [[ -n "${TEST_TUNNEL_ATTEMPT_FILE:-}" ]]; then\n  attempt=1\n  if [[ -f "$TEST_TUNNEL_ATTEMPT_FILE" ]]; then attempt=$(( $(cat "$TEST_TUNNEL_ATTEMPT_FILE") + 1 )); fi\n  printf \'%s\\n\' "$attempt" > "$TEST_TUNNEL_ATTEMPT_FILE"\n  if (( attempt == 1 )); then sleep 0.2; rm -f "$TEST_TUNNEL_READY"; exit 255; fi\nfi\ntrap \'exit 0\' TERM INT\nwhile true; do sleep 1; done\n',
    );
    writeFileSync(
      join(binDir, 'curl'),
      '#!/usr/bin/env bash\nurl="${@: -1}"\n[[ -f "$TEST_TUNNEL_READY" ]] || exit 7\ncase "$url" in\n  */health) printf \'{"ok":true,"server":"kordi-cloud"}\\n\' ;;\n  */v1/cloud/auth/capabilities) [[ -z "${KORDI_DEV_PREVIEW_PATH:-}" ]] || exit 22; printf \'{"password":true,"oauthProviders":["google","github"]}\\n\' ;;\n  *) exit 22 ;;\nesac\n',
    );
    writeFileSync(
      join(binDir, 'pnpm'),
      '#!/usr/bin/env bash\nif [[ -n "${TEST_TUNNEL_ATTEMPT_FILE:-}" ]]; then\n  for _attempt in $(seq 1 80); do\n    if [[ -f "$TEST_TUNNEL_ATTEMPT_FILE" ]] && (( $(cat "$TEST_TUNNEL_ATTEMPT_FILE") >= 2 )); then break; fi\n    sleep 0.1\n  done\nfi\nprintf \'%s\\n\' "$*|$VITE_KORDI_CLOUD_API_BASE|$VITE_KORDI_DEV_PROFILE|${DATABASE_URL:-}|${KORDI_OAUTH_GOOGLE_CLIENT_SECRET:-}|${KORDI_CLOUD_GCP_PROJECT:-}|$VITE_KORDI_ENABLE_LOOPBACK_REALTIME" > "$TEST_DESKTOP_CAPTURE"\n',
    );
    writeFileSync(
      join(binDir, 'nc'),
      '#!/usr/bin/env bash\n[[ -f "$TEST_TUNNEL_READY" ]]\n',
    );
    for (const command of ['gh', 'gcloud', 'curl', 'pnpm', 'nc']) {
      chmodSync(join(binDir, command), 0o755);
    }
    writeFileSync(allowlistPath, 'example-maintainer\n');

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      KORDI_REMOTE_DEV_GITHUB_ALLOWLIST_FILE: allowlistPath,
      KORDI_DEV_GCP_PROJECT: 'example-project',
      KORDI_DEV_SSH_ZONE: 'example-zone',
      KORDI_DEV_SSH_TARGET: 'example-user@example-instance',
      KORDI_DEV_DESKTOP_PROFILE: 'remote-isolated',
      KORDI_DEV_DESKTOP_TITLE: 'Kordi Remote Dev',
      KORDI_DEV_DESKTOP_PORT: '1498',
      TEST_GITHUB_LOGIN: 'example-maintainer',
      TEST_TUNNEL_READY: tunnelReadyPath,
      TEST_GCLOUD_CAPTURE: gcloudCapturePath,
      TEST_DESKTOP_CAPTURE: desktopCapturePath,
      DATABASE_URL: 'postgresql://must-not-reach-desktop',
      KORDI_OAUTH_GOOGLE_CLIENT_SECRET: 'must-not-reach-desktop',
      KORDI_CLOUD_GCP_PROJECT: 'must-not-reach-desktop',
    };
    const launched = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(launched.status, 0, launched.stderr);
    const gcloudArgs = readFileSync(gcloudCapturePath, 'utf8');
    assert.match(gcloudArgs, /compute ssh example-user@example-instance/);
    assert.match(gcloudArgs, /--project example-project/);
    assert.match(gcloudArgs, /--zone example-zone/);
    assert.match(gcloudArgs, /--tunnel-through-iap/);
    assert.match(gcloudArgs, /-L 127\.0\.0\.1:17081:127\.0\.0\.1:17081/);
    assert.equal(
      readFileSync(desktopCapturePath, 'utf8').trim(),
      'dev:desktop:profile -- --profile remote-isolated --title Kordi Remote Dev --port 1498|http://127.0.0.1:17081|community||||1',
    );
    assert.match(launched.stdout, /Verified Google and GitHub OAuth/);

    rmSync(tunnelReadyPath);
    const previewLaunched = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      env: { ...env, KORDI_DEV_PREVIEW_PATH: '/tests/visual/groupMentionPreview.html' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(previewLaunched.status, 0, previewLaunched.stderr);
    assert.match(previewLaunched.stdout, /login-free fixture preview/);

    rmSync(tunnelReadyPath);
    const recovered = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      env: { ...env, TEST_TUNNEL_ATTEMPT_FILE: tunnelAttemptPath },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /The IAP tunnel exited; reconnecting/);
    assert.ok(Number(readFileSync(tunnelAttemptPath, 'utf8')) >= 2);

    rmSync(tunnelReadyPath);
    const mediaLaunched = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      env: {
        ...env,
        KORDI_DEV_LOCAL_SIGNALING_PORT: '17880',
        KORDI_DEV_REMOTE_SIGNALING_PORT: '7880',
        KORDI_DEV_LOCAL_ICE_TCP_PORT: '17881',
        KORDI_DEV_REMOTE_ICE_TCP_PORT: '17881',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(mediaLaunched.status, 0, mediaLaunched.stderr);
    const mediaGcloudArgs = readFileSync(gcloudCapturePath, 'utf8');
    assert.match(mediaGcloudArgs, /-L 127\.0\.0\.1:17880:127\.0\.0\.1:7880/);
    assert.match(mediaGcloudArgs, /-L 127\.0\.0\.1:17881:127\.0\.0\.1:17881/);
    assert.match(mediaLaunched.stdout, /Verified API, OAuth, signaling, and ICE\/TCP/);

    const mismatchedIce = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      env: {
        ...env,
        KORDI_DEV_LOCAL_SIGNALING_PORT: '17880',
        KORDI_DEV_REMOTE_SIGNALING_PORT: '7880',
        KORDI_DEV_LOCAL_ICE_TCP_PORT: '17882',
        KORDI_DEV_REMOTE_ICE_TCP_PORT: '17881',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.notEqual(mismatchedIce.status, 0);
    assert.match(mismatchedIce.stderr, /must match the advertised loopback candidate/);

    const packageJson = read('package.json');
    const guide = read('docs/development-environments.md');
    assert.match(packageJson, /"dev:cloud:remote": "bash scripts\/dev-cloud-remote\.sh"/);
    assert.match(guide, /pnpm dev:cloud:remote/);
    assert.match(guide, /KORDI_DEV_GCP_PROJECT="<DEV_GCP_PROJECT>"/);
    assert.doesNotMatch(guide, /example-project|example-instance/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

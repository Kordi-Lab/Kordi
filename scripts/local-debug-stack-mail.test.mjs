import assert from 'node:assert/strict';
import { test } from 'node:test';

import { read } from './local-debug-stack-helpers.mjs';

function composeService(compose, name) {
  const match = compose.match(new RegExp(`^  ${name}:\\n((?:(?:    .*)?\\n)*)`, 'm'));
  assert.ok(match, `missing compose service ${name}`);
  return match[1];
}

test('debug stack captures sign-up email in a loopback-only Mailpit inbox', () => {
  const compose = read('deploy/dev/compose.yaml');

  assert.match(compose, /^  mailpit:\n(?:    .*\n)*?    image: axllent\/mailpit:v\d+\.\d+\.\d+$/m);
  assert.match(compose, /"127\.0\.0\.1:\$\{KORDI_DEBUG_MAILPIT_UI_PORT:-18025\}:8025"/);
  assert.doesNotMatch(compose, /:1025"?\s*$/m);
  assert.match(compose, /KORDI_AUTH_SMTP_HOST: \$\{KORDI_AUTH_SMTP_HOST:-mailpit\}/);
  assert.match(compose, /KORDI_AUTH_SMTP_PORT: \$\{KORDI_AUTH_SMTP_PORT:-1025\}/);
  assert.match(compose, /KORDI_AUTH_SMTP_SECURITY: \$\{KORDI_AUTH_SMTP_SECURITY:-none\}/);
  assert.match(compose, /KORDI_AUTH_SMTP_FROM: "\$\{KORDI_AUTH_SMTP_FROM:-Kordi Dev <no-reply@example\.test>\}"/);
  assert.match(composeService(compose, 'cloud-server'), /^        KORDI_DEVELOPMENT_BUILD: "1"$/m);
});

test('debug stack runner is a development build so it accepts the local sandbox', () => {
  const runner = composeService(read('deploy/dev/compose.yaml'), 'cloud-agent-runner');

  assert.match(runner, /dockerfile: bridges\/cloud-agent-runner\/Dockerfile\.runtime/);
  assert.match(runner, /^      args:\n(?:        #.*\n)*        KORDI_DEVELOPMENT_BUILD: "1"$/m);
  assert.match(runner, /^      KORDI_CLOUD_SANDBOX_BACKEND: local$/m);
  assert.match(read('bridges/cloud-agent-runner/Dockerfile.runtime'), /^ARG KORDI_DEVELOPMENT_BUILD=$/m);
});

test('hosted image builds never pass the development build marker', () => {
  for (const path of [
    '.github/workflows/backend-delivery.yml',
    'bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh',
    'bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh',
    'bridges/cloud-server/deploy/k3s/manifests/cloud-agent-runner-deployment.yaml',
    'scripts/build-backend-bundle.sh',
    'scripts/build-vps-images.sh',
  ]) {
    assert.doesNotMatch(read(path), /KORDI_DEVELOPMENT_BUILD/, path);
  }
});

test('hosted server images never opt into development-only mail options', () => {
  const developmentDockerfile = read('bridges/cloud-server/Dockerfile');
  const runtimeDockerfile = read('bridges/cloud-server/Dockerfile.runtime');

  assert.match(developmentDockerfile, /^ARG KORDI_DEVELOPMENT_BUILD=$/m);
  assert.doesNotMatch(runtimeDockerfile, /KORDI_DEVELOPMENT_BUILD/);
});

test('debug setup owns the sign-up email secret and ignores parent-shell SMTP settings', () => {
  const helper = read('scripts/dev-cloud-up.sh');
  const smoke = read('scripts/dev-cloud-smoke.sh');

  assert.match(helper, /unset KORDI_AUTH_SMTP_HOST KORDI_AUTH_SMTP_PORT KORDI_AUTH_SMTP_SECURITY/);
  assert.match(helper, /unset KORDI_AUTH_SMTP_USERNAME KORDI_AUTH_SMTP_PASSWORD KORDI_AUTH_SMTP_FROM/);
  assert.match(helper, /unset KORDI_AUTH_EMAIL_CODE_SECRET/);
  assert.match(helper, /Added an isolated sign-up email code secret/);
  assert.match(smoke, /for service in [^;]*\bmailpit\b/);
  assert.match(smoke, /Mailpit inbox \(sign-up codes\): http:\/\/127\.0\.0\.1:\$\{mailpit_port\}/);
});

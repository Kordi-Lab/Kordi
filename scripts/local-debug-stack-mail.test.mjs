import assert from 'node:assert/strict';
import { test } from 'node:test';

import { read } from './local-debug-stack-helpers.mjs';

test('debug stack captures sign-up email in a loopback-only Mailpit inbox', () => {
  const compose = read('deploy/dev/compose.yaml');

  assert.match(compose, /^  mailpit:\n(?:    .*\n)*?    image: axllent\/mailpit:v\d+\.\d+\.\d+$/m);
  assert.match(compose, /"127\.0\.0\.1:\$\{KORDI_DEBUG_MAILPIT_UI_PORT:-18025\}:8025"/);
  assert.doesNotMatch(compose, /:1025"?\s*$/m);
  assert.match(compose, /KORDI_AUTH_SMTP_HOST: \$\{KORDI_AUTH_SMTP_HOST:-mailpit\}/);
  assert.match(compose, /KORDI_AUTH_SMTP_PORT: \$\{KORDI_AUTH_SMTP_PORT:-1025\}/);
  assert.match(compose, /KORDI_AUTH_SMTP_SECURITY: \$\{KORDI_AUTH_SMTP_SECURITY:-none\}/);
  assert.match(compose, /KORDI_AUTH_SMTP_FROM: "\$\{KORDI_AUTH_SMTP_FROM:-Kordi Dev <no-reply@example\.test>\}"/);
  assert.match(compose, /KORDI_DEVELOPMENT_BUILD: "1"/);
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

#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  RELEASE_PROFILES,
  assertProductionSigningIdentity,
  verifyMacAppSignature,
} from '../../../scripts/lib/macos-release-signing.mjs';

const SIGNING_ENV_NAMES = [
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
];
const RELEASE_PROFILE_VALUES = Object.values(RELEASE_PROFILES);

function defaultRun(command, args = []) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function requireSuccessful(result, message) {
  if (result.status !== 0) {
    throw new Error(message);
  }
  return result;
}

function requireNonEmptyEnvironment(env, name) {
  if (typeof env[name] !== 'string' || env[name].trim().length === 0) {
    throw new Error(`${name} is required for a signed desktop release`);
  }
}

function requireReleaseProfile(profile) {
  if (!RELEASE_PROFILE_VALUES.includes(profile)) {
    throw new Error('Release profile must be production or adhoc-preview');
  }
  return profile;
}

export function redactReleaseText(value, env = process.env) {
  let redacted = String(value ?? '');
  for (const [name, secret] of Object.entries(env)) {
    if (!/(KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL)/i.test(name)) continue;
    if (typeof secret !== 'string' || secret.length < 3) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  redacted = redacted.replace(
    /https?:\/\/[^\s/]*(?:minio|\.internal|\.svc(?:\.cluster\.local)?)[^\s]*/gi,
    '[REDACTED_INTERNAL_URL]',
  );
  redacted = redacted.replace(
    /Developer ID Application:[^\r\n"]*(?:\([^\r\n)]*\))?/gi,
    'Developer ID Application: [REDACTED_IDENTITY]',
  );
  return redacted;
}

export function checkReleasePrerequisites(options, dependencies = {}) {
  const {
    expectedCommit,
    sourceOnly = false,
    appBundle,
  } = options ?? {};
  const releaseProfile = requireReleaseProfile(
    options?.releaseProfile ?? RELEASE_PROFILES.PRODUCTION,
  );
  const env = dependencies.env ?? process.env;
  const run = dependencies.run ?? defaultRun;

  if (typeof expectedCommit !== 'string' || expectedCommit.trim().length === 0) {
    throw new Error('--expected-commit is required');
  }

  const status = requireSuccessful(
    run('git', ['status', '--porcelain=v1', '--untracked-files=all']),
    'Unable to inspect the release worktree',
  );
  if (status.stdout.trim().length > 0) {
    throw new Error('Release worktree must be clean');
  }

  const head = requireSuccessful(
    run('git', ['rev-parse', 'HEAD']),
    'Unable to read the release commit',
  ).stdout.trim();
  if (head !== expectedCommit.trim()) {
    throw new Error('Current commit does not match expected release commit');
  }

  if (sourceOnly) {
    return {
      commit: head,
      sourceOnly: true,
      releaseProfile,
      signingIdentityAvailable: false,
      codesignVerified: false,
      gatekeeperVerified: false,
    };
  }

  for (const name of SIGNING_ENV_NAMES) {
    requireNonEmptyEnvironment(env, name);
  }
  if (typeof appBundle !== 'string' || appBundle.trim().length === 0) {
    throw new Error('--app-bundle is required for artifact verification');
  }

  const identity = releaseProfile === RELEASE_PROFILES.PRODUCTION
    ? assertProductionSigningIdentity(run)
    : { signingIdentityAvailable: false };
  const signature = verifyMacAppSignature({
    run,
    appBundle,
    profile: releaseProfile,
  });

  return {
    commit: head,
    sourceOnly: false,
    releaseProfile,
    signingIdentityAvailable: identity.signingIdentityAvailable,
    codesignVerified: signature.codesignVerified,
    gatekeeperVerified: signature.gatekeeperVerified,
  };
}

export function parseReleasePrerequisiteArguments(argv) {
  const options = {
    sourceOnly: false,
    releaseProfile: RELEASE_PROFILES.PRODUCTION,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    } else if (argument === '--source-only') {
      options.sourceOnly = true;
    } else if (argument === '--release-profile') {
      options.releaseProfile = requireReleaseProfile(argv[index += 1]);
    } else if (argument === '--expected-commit') {
      options.expectedCommit = argv[index += 1];
    } else if (argument === '--app-bundle') {
      options.appBundle = argv[index += 1];
    } else {
      throw new Error(`Unknown release prerequisite argument: ${argument}`);
    }
  }
  return options;
}

export function runReleasePrerequisiteCli(argv = process.argv.slice(2)) {
  try {
    const result = checkReleasePrerequisites(parseReleasePrerequisiteArguments(argv));
    const mode = result.sourceOnly
      ? 'source-only'
      : result.releaseProfile === RELEASE_PROFILES.ADHOC_PREVIEW
        ? 'ad-hoc preview artifact'
        : 'production artifact';
    console.log(`[kordi] Release prerequisites passed for ${result.commit} (${mode}).`);
    return 0;
  } catch (error) {
    console.error(`[kordi] Release prerequisites failed: ${redactReleaseText(error?.message ?? error)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runReleasePrerequisiteCli();
}

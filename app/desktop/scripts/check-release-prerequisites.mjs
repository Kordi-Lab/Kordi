#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SIGNING_ENV_NAMES = [
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
];

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

  const identities = requireSuccessful(
    run('security', ['find-identity', '-v', '-p', 'codesigning']),
    'Unable to inspect macOS signing identities',
  );
  const identityOutput = `${identities.stdout}\n${identities.stderr}`;
  const validIdentityCount = identityOutput.match(/(\d+) valid identities found/i);
  if (!/Developer ID Application:/i.test(identityOutput)
      || !validIdentityCount
      || Number(validIdentityCount[1]) < 1) {
    throw new Error('A valid Developer ID Application signing identity is required');
  }

  requireSuccessful(
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]),
    'codesign verification failed for the application bundle',
  );
  requireSuccessful(
    run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appBundle]),
    'Gatekeeper assessment failed for the application bundle',
  );

  return {
    commit: head,
    sourceOnly: false,
    signingIdentityAvailable: true,
    codesignVerified: true,
    gatekeeperVerified: true,
  };
}

export function parseReleasePrerequisiteArguments(argv) {
  const options = { sourceOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    } else if (argument === '--source-only') {
      options.sourceOnly = true;
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
    const mode = result.sourceOnly ? 'source-only' : 'signed artifact';
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

#!/usr/bin/env node

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  redactPublisherText,
  rollbackDesktopBetaChannel,
} from './lib/desktop-release.mjs';
import {
  createPublicHttpAdapter,
  createS3ReleaseStore,
} from './publish-desktop-release.mjs';

export function parseRollbackArguments(argv) {
  let expectedCurrentVersion;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument !== '--expected-current-version') {
      throw new Error(`Unknown rollback argument: ${argument}`);
    }
    const value = argv[index += 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--expected-current-version requires a value');
    }
    expectedCurrentVersion = value;
  }
  if (!expectedCurrentVersion) throw new Error('--expected-current-version is required');
  return { expectedCurrentVersion };
}

export async function runRollbackCli(argv = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env ?? process.env;
  try {
    const options = parseRollbackArguments(argv);
    const store = dependencies.store ?? await createS3ReleaseStore({ env });
    const publicHttp = dependencies.publicHttp ?? createPublicHttpAdapter();
    const logger = dependencies.logger ?? {
      info(message) {
        console.log(redactPublisherText(message, env));
      },
    };
    const result = await rollbackDesktopBetaChannel(options, {
      store,
      publicHttp,
      logger,
    });
    console.log(`[release] rolled back beta channel from ${result.removedVersion}`);
    return 0;
  } catch (error) {
    console.error(`[release] rollback failed: ${redactPublisherText(error?.message ?? error, env)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runRollbackCli();
}

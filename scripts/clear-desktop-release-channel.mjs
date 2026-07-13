#!/usr/bin/env node

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  clearDesktopReleaseChannel,
  redactPublisherText,
} from './lib/desktop-release.mjs';
import {
  createPublicHttpAdapter,
  createS3ReleaseStore,
} from './publish-desktop-release.mjs';

export function parseClearChannelArguments(argv) {
  let channel;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument !== '--channel') throw new Error(`Unknown cleanup argument: ${argument}`);
    const value = argv[index += 1];
    if (!value || value.startsWith('--')) throw new Error('--channel requires a value');
    channel = value;
  }
  if (channel !== 'acceptance') {
    throw new Error('Only the acceptance channel can be cleared by this command');
  }
  return { channel };
}

export async function runClearChannelCli(argv = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env ?? process.env;
  try {
    const options = parseClearChannelArguments(argv);
    const store = dependencies.store ?? await createS3ReleaseStore({ env });
    const publicHttp = dependencies.publicHttp ?? createPublicHttpAdapter();
    const logger = dependencies.logger ?? {
      info(message) {
        console.log(redactPublisherText(message, env));
      },
    };
    const result = await clearDesktopReleaseChannel(options, {
      store,
      publicHttp,
      logger,
    });
    console.log(`[release] acceptance channel ${result.removed ? 'cleared' : 'already clear'}`);
    return 0;
  } catch (error) {
    console.error(`[release] cleanup failed: ${redactPublisherText(error?.message ?? error, env)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runClearChannelCli();
}

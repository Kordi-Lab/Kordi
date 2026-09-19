#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { validateSha, validateStackId } from './dev-stack-allocate.mjs';

const { values } = parseArgs({ options: {
  stack: { type: 'string' }, sha: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: pnpm deploy:dev --stack <allocated-stack> [--sha <tested-full-sha>]');
} else {
  try {
    const sha = values.sha ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    for (const result of [validateStackId(values.stack), validateSha(sha)]) {
      if (!result.ok) throw new Error(result.error);
    }
    execFileSync('gh', ['workflow', 'run', 'deploy-dev.yml', '--ref', 'main',
      '-f', `stack=${values.stack}`, '-f', `sha=${sha}`], { stdio: 'inherit' });
    console.log(`Requested deployment of ${sha} to ${values.stack}. Follow progress with gh run list --workflow deploy-dev.yml.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

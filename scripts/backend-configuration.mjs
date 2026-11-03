#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigurationError, parseBackendConfiguration } from '../shared/configuration/backend.mjs';
import { backendConfigurationArtifacts } from '../shared/configuration/artifacts.mjs';

const USAGE = `Usage: node scripts/backend-configuration.mjs
  --config <file> --edition <app|research> --environment <staging|production>
  --expected-backend-origin <origin> [--output-dir <new-directory>]

Without --output-dir, validate only. Never builds, signs, deploys or contacts a backend.
The expected target must come from reviewed ops policy, not from the candidate file.
Generated inputs cover backend routing only, not native identity or updater configuration.`;

function argumentsFor(argv) {
  const supported = ['--config', '--edition', '--environment', '--expected-backend-origin', '--output-dir'];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!supported.includes(key) || options.has(key) || !value || value.startsWith('--')) {
      throw new ConfigurationError('Invalid, duplicate or missing command argument.');
    }
    options.set(key, value);
  }
  if (supported.slice(0, 4).some((key) => !options.has(key))) {
    throw new ConfigurationError('Configuration file and expected target arguments are required.');
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(USAGE);
    return 0;
  }
  try {
    const options = argumentsFor(argv);
    let text;
    try {
      text = readFileSync(options.get('--config'), 'utf8');
    } catch {
      throw new ConfigurationError('Unable to read configuration file.');
    }
    const expected = {
      edition: options.get('--edition'),
      environment: options.get('--environment'),
      backendOrigin: options.get('--expected-backend-origin'),
    };
    const configuration = parseBackendConfiguration(text, expected);
    const artifacts = backendConfigurationArtifacts(configuration, expected);
    if (options.has('--output-dir')) {
      const output = path.resolve(options.get('--output-dir'));
      // A new directory prevents overwriting a source file, existing output or symlink.
      // Parent directories must already exist. A failed write is not a completed export.
      try {
        mkdirSync(output, { mode: 0o700 });
        for (const [name, contents] of Object.entries(artifacts)) {
          writeFileSync(path.join(output, name), contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        }
      } catch {
        throw new ConfigurationError('Unable to write artifacts to a new output directory.');
      }
    }
    console.log(options.has('--output-dir')
      ? 'Backend configuration validated and backend-only artifacts generated. No deployment performed.'
      : 'Backend configuration validated. No files changed or deployment performed.');
    return 0;
  } catch (error) {
    // Do not echo candidate values, file paths or JSON parser excerpts.
    console.error(error instanceof ConfigurationError ? error.message : 'Backend configuration operation failed.');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}

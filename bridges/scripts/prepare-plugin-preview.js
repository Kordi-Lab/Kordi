#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const DEFAULT_OUTPUT_DIR = '/tmp/bridges-publish-preview';

function main() {
  const outputDir = resolve(process.argv[2] || process.env.BRIDGES_PLUGIN_PREVIEW_DIR || DEFAULT_OUTPUT_DIR);
  const manifestPath = join(ROOT, '.claude-plugin', 'marketplace.json');
  const skillDir = join(ROOT, 'skills', 'bridges');

  if (!existsSync(manifestPath)) {
    if (process.env.BRIDGES_PLUGIN_PREVIEW_REQUIRED === '1') {
      console.error(`Marketplace manifest not found: ${manifestPath}`);
      process.exit(1);
    }

    console.log(`Skipping Claude Code plugin preview: marketplace manifest not found at ${manifestPath}`);
    return;
  }

  if (!existsSync(skillDir)) {
    console.error(`Plugin skill directory not found: ${skillDir}`);
    process.exit(1);
  }

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(join(outputDir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(outputDir, 'skills'), { recursive: true });

  cpSync(skillDir, join(outputDir, 'skills', 'bridges'), { recursive: true });
  cpSync(manifestPath, join(outputDir, '.claude-plugin', 'marketplace.json'));

  const readme = [
    '# bridges plugin preview',
    '',
    'This directory is generated for Claude Code plugin installs.',
    'It intentionally excludes Rust build artifacts and other repo files.',
    ''
  ].join('\n');
  writeFileSync(join(outputDir, 'README.md'), readme);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  console.log(`Prepared Claude Code plugin preview at: ${outputDir}`);
  console.log(`Marketplace: ${manifest.name}`);
  console.log('Install with:');
  console.log(`  claude plugin marketplace add ${outputDir}`);
  console.log(`  claude plugin install ${manifest.plugins[0].name}@${manifest.name}`);
}

main();

#!/usr/bin/env node

/**
 * Keep package.json and cli/Cargo.toml versions in sync.
 * Reads the version from package.json and writes it into cli/Cargo.toml.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

function main() {
  // Read version from package.json
  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = pkg.version;

  if (!version) {
    console.error('No version found in package.json');
    process.exit(1);
  }

  // Update cli/Cargo.toml
  const cargoPath = join(ROOT, 'cli', 'Cargo.toml');
  let cargo = readFileSync(cargoPath, 'utf8');

  // Match the version line under [package] section
  const versionRegex = /^(version\s*=\s*")([^"]+)(")/m;
  const match = cargo.match(versionRegex);

  if (!match) {
    console.error('Could not find version field in cli/Cargo.toml');
    process.exit(1);
  }

  const oldVersion = match[2];

  if (oldVersion === version) {
    console.log(`Versions already in sync: ${version}`);
    return;
  }

  cargo = cargo.replace(versionRegex, `$1${version}$3`);
  writeFileSync(cargoPath, cargo);

  console.log(`Updated cli/Cargo.toml: ${oldVersion} -> ${version}`);
}

main();

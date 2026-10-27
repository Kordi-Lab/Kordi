#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MACHO_MAGICS = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);

export function versionParts(version) {
  if (typeof version !== 'string' || !/^[1-9][0-9]*\.(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))?$/.test(version) || version.split('.').some((part) => Number(part) > 65535)) throw new Error('Invalid macOS minimum version');
  return version.split('.').map(Number).concat([0]).slice(0, 3);
}

export function assertMachOMinimum(loadCommands, supportedVersion) {
  const supported = versionParts(supportedVersion);
  const versions = [];
  for (const command of loadCommands.split(/Load command \d+/)) {
    if (/\bcmd LC_BUILD_VERSION\b/.test(command)) {
      if (!/\bplatform (?:1|macos)\b/i.test(command)) throw new Error('Shipped Mach-O targets a non-macOS platform');
      const match = command.match(/\bminos (\d+\.\d+(?:\.\d+)?)/);
      if (!match) throw new Error('Missing Mach-O deployment minimum');
      versions.push(match[1]);
    } else if (/\bcmd LC_VERSION_MIN_MACOSX\b/.test(command)) {
      const match = command.match(/\bversion (\d+\.\d+(?:\.\d+)?)/);
      if (!match) throw new Error('Missing Mach-O deployment minimum');
      versions.push(match[1]);
    }
  }
  if (!versions.length) throw new Error('Missing Mach-O deployment minimum');
  for (const version of versions) {
    const actual = versionParts(version);
    const firstDifference = actual.findIndex((part, index) => part !== supported[index]);
    if (firstDifference >= 0 && actual[firstDifference] > supported[firstDifference]) {
      throw new Error('Shipped Mach-O requires a newer macOS version than the app advertises');
    }
  }
}

export function checkMacOSRuntimeMinimum(appBundle, {
  expectedMinimum = '13.0',
  run = (command, args) => spawnSync(command, args, { encoding: 'utf8' }),
} = {}) {
  versionParts(expectedMinimum);
  const plist = run('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', join(appBundle, 'Contents', 'Info.plist')]);
  if (plist.status !== 0 || plist.stdout.trim() !== expectedMinimum) throw new Error('App minimum does not match the supported macOS version');
  let count = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      if (!entry.isFile()) continue;
      const bytes = Buffer.alloc(4);
      const fd = openSync(path, 'r');
      try { readSync(fd, bytes, 0, 4, 0); } finally { closeSync(fd); }
      if (!MACHO_MAGICS.has(bytes.toString('hex'))) continue;
      const result = run('otool', ['-l', path]);
      if (result.status !== 0) throw new Error('Unable to inspect a shipped Mach-O');
      try { assertMachOMinimum(result.stdout, expectedMinimum); } catch (error) {
        throw new Error(`${relative(appBundle, path)}: ${error.message}`);
      }
      count += 1;
    }
  };
  visit(join(appBundle, 'Contents'));
  if (!count) throw new Error('No shipped Mach-O binaries found');
  return { minimumSystemVersion: expectedMinimum, binaryCount: count };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Provide the Kordi.app bundle path');
  console.log(JSON.stringify(checkMacOSRuntimeMinimum(process.argv[2])));
}

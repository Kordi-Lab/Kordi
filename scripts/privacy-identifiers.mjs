#!/usr/bin/env node
// Maintains and applies the hashed private-identifier list without echoing any value.
//
//   pnpm privacy:add-identifier          read identifiers from stdin, one per line, and add
//                                        their SHA-256 hashes to the committed list
//   node scripts/privacy-identifiers.mjs scan
//                                        read text from stdin and fail if it contains a
//                                        listed identifier (prints a count only)

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { findPrivateIdentifiers, hashPrivateIdentifier } from './lib/private-identifiers.mjs';

const HASHES_URL = new URL('./lib/private-identifier-hashes.json', import.meta.url);

async function readLines(input = process.stdin) {
  const lines = [];
  for await (const line of createInterface({ input, crlfDelay: Infinity })) lines.push(line);
  return lines;
}

export function addIdentifierHashes(existing, values) {
  const hashes = new Set(existing);
  let added = 0;
  for (const value of values.map((line) => line.trim()).filter(Boolean)) {
    const hash = hashPrivateIdentifier(value);
    if (!hashes.has(hash)) added += 1;
    hashes.add(hash);
  }
  return { hashes: [...hashes].sort(), added };
}

async function add() {
  if (process.stdin.isTTY) {
    console.error('Type one identifier per line, then press Ctrl-D. Input is not echoed back.');
  }
  const existing = JSON.parse(readFileSync(HASHES_URL, 'utf8'));
  const { hashes, added } = addIdentifierHashes(existing, await readLines());
  writeFileSync(HASHES_URL, `${JSON.stringify(hashes, null, 2)}\n`);
  console.log(`[kordi] Added ${added} identifier hash(es); the list now has ${hashes.length}.`);
  console.log('[kordi] Run pnpm privacy:check to confirm the tree does not already contain them.');
}

async function scan() {
  const matched = new Set();
  for (const line of await readLines()) {
    for (const hash of findPrivateIdentifiers(line)) matched.add(hash);
  }
  if (matched.size === 0) {
    console.log('[kordi] No hashed private identifiers found.');
    return;
  }
  console.error(`[kordi] Found ${matched.size} hashed private identifier(s); values are not printed.`);
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv.slice(2).find((argument) => argument !== '--');
  if (command === 'add') await add();
  else if (command === 'scan') await scan();
  else {
    console.error('usage: privacy-identifiers.mjs add|scan < input');
    process.exitCode = 2;
  }
}

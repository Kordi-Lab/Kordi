// Exact private identifiers (instance names, project ids, legacy hosts, former addresses,
// login names, private repository names) are committed only as SHA-256 hashes so that the
// guard can block them without publishing the values it protects.
//
// Matching contract: text is lowercased and split into dotted tokens made of letters, digits,
// "_" and "-". Every contiguous run of up to MAX_LABELS dot-separated labels is hashed, so an
// entry matches a whole label sequence: "203.0.113.7" matches inside
// "name.203.0.113.7.example.io", and "host-a" matches "host-a.example.com" but not
// "host-a-backup". Add the exact label sequence that must never appear.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const MAX_LABELS = 8;
const TOKEN = /[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*/g;

export const PRIVATE_IDENTIFIER_HASHES = new Set(
  JSON.parse(readFileSync(new URL('./private-identifier-hashes.json', import.meta.url), 'utf8')),
);

export function hashPrivateIdentifier(value) {
  return createHash('sha256').update(String(value).trim().toLocaleLowerCase('en-US')).digest('hex');
}

const verdictCache = new Map();

function isDenied(candidate, hashes) {
  if (hashes !== PRIVATE_IDENTIFIER_HASHES) {
    return hashes.has(hashPrivateIdentifier(candidate));
  }
  let verdict = verdictCache.get(candidate);
  if (verdict === undefined) {
    verdict = hashes.has(hashPrivateIdentifier(candidate));
    if (verdictCache.size > 500_000) verdictCache.clear();
    verdictCache.set(candidate, verdict);
  }
  return verdict;
}

// Returns the hashes of matched identifiers, never the matched text.
export function findPrivateIdentifiers(contents, hashes = PRIVATE_IDENTIFIER_HASHES) {
  if (!contents || hashes.size === 0) return [];
  const matched = new Set();
  const seenTokens = new Set();
  for (const [token] of String(contents).toLocaleLowerCase('en-US').matchAll(TOKEN)) {
    if (seenTokens.has(token)) continue;
    seenTokens.add(token);
    const labels = token.split('.');
    for (let start = 0; start < labels.length; start += 1) {
      const limit = Math.min(labels.length, start + MAX_LABELS);
      for (let end = start + 1; end <= limit; end += 1) {
        const candidate = labels.slice(start, end).join('.');
        if (isDenied(candidate, hashes)) matched.add(hashPrivateIdentifier(candidate));
      }
    }
  }
  return [...matched];
}

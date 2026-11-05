import { homedir } from 'node:os';

import { findPrivateIdentifiers, PRIVATE_IDENTIFIER_HASHES } from './private-identifiers.mjs';

const SENSITIVE_PATTERNS = [
  'pi-clipboard',
  '/var/folders',
  '/Users/',
  '/private/tmp',
  'accountId["\x27]?\\s*[:=]\\s*["\x27][^"\x27]+',
  'displayName["\x27]?\\s*[:=]\\s*["\x27]111',
  'primaryEmail',
  'sessionToken',
  'sslip\\.io',
];
// Former hosts and addresses are compared by hash (scripts/lib/private-identifier-hashes.json)
// so the scanner does not publish them. rg extracts address-shaped strings for that check.
const IPV4_SHAPED = '(?:[0-9]{1,3}\\.){3}[0-9]{1,3}';
// The bundled agent runtime is third-party code whose own source text and upstream
// build paths contain these generic strings. Its files get every other pattern plus
// the build host's home directory, which is what a real leak from this build would carry.
const VENDORED_RUNTIME_SOURCE_PATTERNS = new Set([
  '/Users/',
  '/private/tmp',
  'accountId["\x27]?\\s*[:=]\\s*["\x27][^"\x27]+',
  'sessionToken',
]);
const VENDORED_RUNTIME_GLOBS = ['**/Contents/MacOS/kordi-omp', '**/Contents/MacOS/pi_natives.*.node'];

export function releaseTreeScanArguments(root) {
  const args = ['--text', '--hidden', '--no-ignore', '--no-messages', '-n'];
  for (const pattern of SENSITIVE_PATTERNS) args.push('-e', pattern);
  for (const glob of VENDORED_RUNTIME_GLOBS) args.push('--glob', `!${glob}`);
  args.push(root);
  return args;
}

export function vendoredRuntimeScanArguments(root, { homeDirectory = homedir() } = {}) {
  const args = ['--text', '--hidden', '--no-ignore', '--no-messages', '-n'];
  for (const pattern of SENSITIVE_PATTERNS) {
    if (!VENDORED_RUNTIME_SOURCE_PATTERNS.has(pattern)) args.push('-e', pattern);
  }
  if (homeDirectory.length > 1) args.push('-e', homeDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const glob of VENDORED_RUNTIME_GLOBS) args.push('--glob', glob);
  args.push(root);
  return args;
}

export function releaseAddressScanArguments(root) {
  return ['--text', '--hidden', '--no-ignore', '--no-messages', '-n', '-o', '-e', IPV4_SHAPED, root];
}

// Fails when a hashed former host address appears in the bundle; the error never names it.
export function assertReleaseAddressesClean(run, root, hashes = PRIVATE_IDENTIFIER_HASHES) {
  const addresses = run('rg', releaseAddressScanArguments(root));
  if (addresses.status === 0 && findPrivateIdentifiers(addresses.stdout, hashes).length > 0) {
    throw new Error('Release privacy scan found a forbidden value');
  }
  if (addresses.status !== 0 && addresses.status !== 1) {
    throw new Error('Release privacy scan could not inspect the application bundle');
  }
}

export function redactPublisherText(value, env = process.env) {
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
  redacted = redacted.replace(/Developer ID Application:[^\r\n"]*(?:\([^\r\n)]*\))?/gi, 'Developer ID Application: [REDACTED_IDENTITY]');
  return redacted;
}

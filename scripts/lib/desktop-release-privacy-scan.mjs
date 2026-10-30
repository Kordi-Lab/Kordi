import { homedir } from 'node:os';

const SENSITIVE_PATTERNS = [
  'pi-clipboard',
  '/var/folders',
  '/Users/',
  '/private/tmp',
  'accountId["\x27]?\\s*[:=]\\s*["\x27][^"\x27]+',
  'displayName["\x27]?\\s*[:=]\\s*["\x27]111',
  'primaryEmail',
  'sessionToken',
  'korde-product',
  '35\\.188\\.85\\.31',
  'sslip\\.io',
];
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

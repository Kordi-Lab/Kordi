import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detachDmg,
  mountDmg,
  validateDmgVolumeLayout,
} from '../../app/desktop/scripts/assert-macos-dmg-release.mjs';

export const PRODUCT_ORIGIN = 'https://coordinar.io';
export const TAURI_UPDATER_PUBLIC_KEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDY3N0JBRkMwRDRDNzFEOUIKUldTYkhjZlV3Szk3WjVXWWVmNzZGanNDakFlRkxTZ3UwZ1dLelpJenl3NnY3YmkvZCtEcUxxUWcK';

const REPO_ROOT = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;
const SAFE_CHANNELS = new Set(['beta', 'acceptance']);
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
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function strictBase64(value, label) {
  const text = requireString(value, label);
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new Error(`${label} is not valid base64`);
  }
  const decoded = Buffer.from(text, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== text) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertSignatureShape(signature) {
  const decoded = strictBase64(signature, 'Updater signature').toString('utf8');
  const lower = decoded.toLowerCase();
  if (
    decoded.length < 100
    || !decoded.startsWith('untrusted comment:')
    || !decoded.includes('\ntrusted comment:')
    || !decoded.toLowerCase().includes('signature')
    || /(template|example|placeholder|todo|change[_ -]?me)/i.test(lower)
  ) {
    throw new Error('Updater signature metadata is invalid');
  }
}

function parseMinisign(publicKeyBase64, signatureBase64) {
  const publicKeyText = strictBase64(publicKeyBase64, 'Updater public key').toString('utf8');
  const publicLines = publicKeyText.trimEnd().split(/\r?\n/);
  if (publicLines.length !== 2 || !publicLines[0].startsWith('untrusted comment:')) {
    throw new Error('Updater public key is invalid');
  }
  const publicPacket = strictBase64(publicLines[1], 'Minisign public key packet');
  if (publicPacket.length !== 42 || publicPacket.subarray(0, 2).toString('ascii') !== 'Ed') {
    throw new Error('Updater public key is invalid');
  }

  const signatureText = strictBase64(signatureBase64, 'Updater signature').toString('utf8');
  const signatureLines = signatureText.trimEnd().split(/\r?\n/);
  if (
    signatureLines.length !== 4
    || !signatureLines[0].startsWith('untrusted comment:')
    || !signatureLines[2].startsWith('trusted comment: ')
  ) {
    throw new Error('Updater signature is invalid');
  }
  const signaturePacket = strictBase64(signatureLines[1], 'Minisign signature packet');
  const globalSignature = strictBase64(signatureLines[3], 'Minisign global signature');
  if (signaturePacket.length !== 74 || globalSignature.length !== 64) {
    throw new Error('Updater signature is invalid');
  }
  const algorithm = signaturePacket.subarray(0, 2).toString('ascii');
  if (algorithm !== 'Ed' && algorithm !== 'ED') {
    throw new Error('Updater signature uses an unsupported algorithm');
  }
  if (!safeEqual(publicPacket.subarray(2, 10), signaturePacket.subarray(2, 10))) {
    throw new Error('Updater signature key does not match the embedded public key');
  }
  return {
    algorithm,
    publicKey: publicPacket.subarray(10, 42),
    signature: signaturePacket.subarray(10, 74),
    globalSignature,
    trustedComment: signatureLines[2].slice('trusted comment: '.length),
  };
}

export function verifyTauriUpdaterSignature(data, signatureBase64, publicKeyBase64 = TAURI_UPDATER_PUBLIC_KEY) {
  try {
    const parsed = parseMinisign(publicKeyBase64, signatureBase64);
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, parsed.publicKey]),
      format: 'der',
      type: 'spki',
    });
    const payload = parsed.algorithm === 'ED'
      ? createHash('blake2b512').update(data).digest()
      : Buffer.from(data);
    if (!verifySignature(null, payload, key, parsed.signature)) {
      throw new Error('primary signature mismatch');
    }
    const globalPayload = Buffer.concat([
      parsed.signature,
      Buffer.from(parsed.trustedComment),
    ]);
    if (!verifySignature(null, globalPayload, key, parsed.globalSignature)) {
      throw new Error('global signature mismatch');
    }
  } catch (error) {
    throw new Error('Updater signature verification failed', { cause: error });
  }
}

async function requireDirectory(path, label) {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new Error(`${label} does not exist`);
  }
  if (!details.isDirectory()) throw new Error(`${label} must be a directory`);
}

async function requireFile(path, label) {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (!details.isFile() || details.size <= 0) throw new Error(`${label} must be a non-empty file`);
  return readFile(path);
}

function validateOptions(options) {
  const releaseDir = resolve(requireString(options?.releaseDir, '--release-dir'));
  const appBundle = resolve(requireString(options?.appBundle, '--app-bundle'));
  const version = requireString(options?.version, '--version');
  const channel = requireString(options?.channel, '--channel');
  const expectedCommit = requireString(options?.expectedCommit, '--expected-commit');
  const pubDate = options?.pubDate === undefined
    ? new Date().toISOString()
    : requireString(options.pubDate, '--pub-date');
  if (!VERSION_PATTERN.test(version)) throw new Error('Release version must be a beta semantic version');
  if (!SAFE_CHANNELS.has(channel)) throw new Error('Release channel must be beta or acceptance');
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) throw new Error('Expected commit must be a full lowercase Git commit SHA');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(pubDate) || Number.isNaN(Date.parse(pubDate))) {
    throw new Error('Publication date must be an RFC 3339 UTC timestamp');
  }
  return {
    releaseDir,
    appBundle,
    version,
    channel,
    expectedCommit,
    pubDate,
    dryRun: options?.dryRun === true,
  };
}

export async function prepareDesktopRelease(options, dependencies = {}) {
  const normalized = validateOptions(options);
  await requireDirectory(normalized.releaseDir, 'Release directory');
  await requireDirectory(normalized.appBundle, 'Application bundle');

  const manualName = `Kordi_${normalized.version}_aarch64.dmg`;
  const updaterName = 'Kordi.app.tar.gz';
  const signatureName = `${updaterName}.sig`;
  const manualPath = join(normalized.releaseDir, manualName);
  const updaterPath = join(normalized.releaseDir, updaterName);
  const signaturePath = join(normalized.releaseDir, signatureName);
  const [manualBytes, updaterBytes, signatureBytes] = await Promise.all([
    requireFile(manualPath, 'Desktop DMG'),
    requireFile(updaterPath, 'Tauri updater archive'),
    requireFile(signaturePath, 'Tauri updater signature'),
  ]);
  const signature = signatureBytes.toString('utf8').trim();
  assertSignatureShape(signature);

  const verifier = dependencies.verifier ?? createProductionVerifier();
  if (!verifier || typeof verifier.verify !== 'function') {
    throw new Error('A local release verifier is required');
  }
  await verifier.verify({
    ...normalized,
    manualPath,
    updaterPath,
    signaturePath,
    manualBytes,
    updaterBytes,
    signature,
    updaterPublicKey: TAURI_UPDATER_PUBLIC_KEY,
  });

  const releasePrefix = `desktop/releases/${normalized.version}`;
  const manualKey = `${releasePrefix}/macos/aarch64/${manualName}`;
  const updaterKey = `${releasePrefix}/macos/aarch64/${updaterName}`;
  const signatureKey = `${releasePrefix}/macos/aarch64/${signatureName}`;
  const releaseKey = `${releasePrefix}/release.json`;
  const checksumsKey = `${releasePrefix}/checksums.sha256`;
  const manualDigest = sha256(manualBytes);
  const updaterDigest = sha256(updaterBytes);
  const signatureDigest = sha256(signatureBytes);

  const release = {
    schemaVersion: 1,
    version: normalized.version,
    notes: `Kordi ${normalized.version}`,
    pubDate: normalized.pubDate,
    changelogUrl: `https://github.com/Kordi-AI/Kordi/releases/tag/V${normalized.version.replace(/-beta\./, '.beta')}`,
    manual: {
      objectKey: manualKey,
      fileName: manualName,
      contentType: 'application/x-apple-diskimage',
      sha256: manualDigest,
      sizeBytes: manualBytes.length,
    },
    platforms: {
      'darwin-aarch64': {
        objectKey: updaterKey,
        fileName: updaterName,
        contentType: 'application/gzip',
        signature,
        sha256: updaterDigest,
        sizeBytes: updaterBytes.length,
      },
    },
  };
  const releaseBytes = jsonBytes(release);
  const releaseDigest = sha256(releaseBytes);
  const checksumsBytes = Buffer.from([
    `${manualDigest}  macos/aarch64/${manualName}`,
    `${updaterDigest}  macos/aarch64/${updaterName}`,
    `${signatureDigest}  macos/aarch64/${signatureName}`,
    `${releaseDigest}  release.json`,
    '',
  ].join('\n'));
  const pointer = {
    schemaVersion: 1,
    channel: normalized.channel,
    releaseManifestKey: releaseKey,
    releaseManifestSha256: releaseDigest,
  };
  const pointerBytes = jsonBytes(pointer);
  const pointerKey = `desktop/channels/${normalized.channel}/latest.json`;
  const updaterEndpointPath = normalized.channel === 'acceptance'
    ? '/updates/desktop/acceptance/darwin/aarch64/0.0.0'
    : '/updates/desktop/darwin/aarch64/0.0.0';
  const urls = {
    manual: `${PRODUCT_ORIGIN}/updates/releases/${normalized.version}/${manualName}`,
    updaterArchive: `${PRODUCT_ORIGIN}/updates/releases/${normalized.version}/${updaterName}`,
    updaterEndpoint: `${PRODUCT_ORIGIN}${updaterEndpointPath}`,
    stableManual: `${PRODUCT_ORIGIN}/updates/releases/latest/Kordi.dmg`,
  };
  const artifacts = {
    manual: { path: manualPath, bytes: manualBytes, sha256: manualDigest },
    updater: { path: updaterPath, bytes: updaterBytes, sha256: updaterDigest },
    signature: { path: signaturePath, bytes: signatureBytes, sha256: signatureDigest },
  };
  const immutableObjects = [
    { key: manualKey, bytes: manualBytes, contentType: 'application/x-apple-diskimage' },
    { key: updaterKey, bytes: updaterBytes, contentType: 'application/gzip' },
    { key: signatureKey, bytes: signatureBytes, contentType: 'text/plain; charset=utf-8' },
    { key: checksumsKey, bytes: checksumsBytes, contentType: 'text/plain; charset=utf-8' },
    { key: releaseKey, bytes: releaseBytes, contentType: 'application/json' },
  ];

  await Promise.all([
    writeFile(join(normalized.releaseDir, 'release.json'), releaseBytes),
    writeFile(join(normalized.releaseDir, 'checksums.sha256'), checksumsBytes),
    writeFile(join(normalized.releaseDir, `channel-${normalized.channel}-latest.json`), pointerBytes),
  ]);

  return {
    ...normalized,
    release,
    releaseBytes,
    checksumsBytes,
    pointer,
    pointerBytes,
    pointerKey,
    immutableObjects,
    artifacts,
    urls,
  };
}

function headerValue(response, name) {
  if (response?.headers?.get) return response.headers.get(name);
  const entries = Object.entries(response?.headers ?? {});
  return entries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
}

function responseBody(response) {
  if (Buffer.isBuffer(response?.body)) return response.body;
  if (response?.body instanceof Uint8Array) return Buffer.from(response.body);
  if (typeof response?.body === 'string') return Buffer.from(response.body);
  throw new Error('Public response body is unavailable');
}

async function verifyPublicAsset(publicHttp, url, expectedBytes, expectedDigest) {
  const head = await publicHttp.head(url);
  if (head?.status !== 200) throw new Error(`Public HEAD verification failed with status ${head?.status ?? 'unknown'}`);
  if (headerValue(head, 'content-length') !== String(expectedBytes.length)) {
    throw new Error('Public HEAD content length does not match the release artifact');
  }
  if (headerValue(head, 'x-checksum-sha256') !== expectedDigest) {
    throw new Error('Public HEAD digest does not match the release artifact');
  }

  const get = await publicHttp.get(url);
  if (get?.status !== 200) throw new Error(`Public GET verification failed with status ${get?.status ?? 'unknown'}`);
  const bytes = responseBody(get);
  if (bytes.length !== expectedBytes.length || sha256(bytes) !== expectedDigest) {
    throw new Error('Public GET length or digest does not match the release artifact');
  }
  const responseDigest = headerValue(get, 'x-checksum-sha256');
  if (responseDigest !== expectedDigest) throw new Error('Public GET checksum header is invalid');
}

async function verifyPromotedRelease(prepared, publicHttp) {
  const response = await publicHttp.get(prepared.urls.updaterEndpoint);
  if (response?.status !== 200) {
    throw new Error(`Updater endpoint post-promotion verification failed with status ${response?.status ?? 'unknown'}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(responseBody(response).toString('utf8'));
  } catch {
    throw new Error('Updater endpoint returned invalid JSON after promotion');
  }
  const updaterAsset = prepared.release.platforms['darwin-aarch64'];
  if (
    manifest.version !== prepared.version
    || manifest.notes !== prepared.release.notes
    || manifest.pub_date !== prepared.pubDate
    || manifest.url !== prepared.urls.updaterArchive
    || manifest.signature !== updaterAsset.signature
  ) {
    throw new Error('Updater endpoint returned unexpected release metadata after promotion');
  }
  if (prepared.channel === 'beta') {
    await verifyPublicAsset(
      publicHttp,
      prepared.urls.stableManual,
      prepared.artifacts.manual.bytes,
      prepared.artifacts.manual.sha256,
    );
  }
}

export async function publishDesktopRelease(options, dependencies = {}) {
  const prepared = await prepareDesktopRelease(options, dependencies);
  const logger = dependencies.logger ?? { info() {} };
  if (prepared.dryRun) {
    logger.info(`[release] dry-run verified ${prepared.version} (${prepared.channel})`);
    return { ...prepared, dryRun: true, published: false };
  }
  const { store, publicHttp } = dependencies;
  if (!store || typeof store.getObject !== 'function' || typeof store.putObject !== 'function' || typeof store.deleteObject !== 'function') {
    throw new Error('A release object store adapter is required');
  }
  if (!publicHttp || typeof publicHttp.get !== 'function' || typeof publicHttp.head !== 'function') {
    throw new Error('A public HTTP verification adapter is required');
  }

  const missing = [];
  for (const object of prepared.immutableObjects) {
    const existing = await store.getObject(object.key);
    if (existing === null || existing === undefined) {
      missing.push(object);
    } else if (!safeEqual(existing, object.bytes)) {
      throw new Error(`Immutable object conflict at ${object.key}`);
    }
  }
  for (const object of missing) {
    await store.putObject(object.key, object.bytes, {
      contentType: object.contentType,
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      immutable: true,
    });
    logger.info(`[release] stored immutable ${object.key} (${object.bytes.length} bytes, sha256 ${sha256(object.bytes)})`);
  }

  await verifyPublicAsset(
    publicHttp,
    prepared.urls.manual,
    prepared.artifacts.manual.bytes,
    prepared.artifacts.manual.sha256,
  );
  await verifyPublicAsset(
    publicHttp,
    prepared.urls.updaterArchive,
    prepared.artifacts.updater.bytes,
    prepared.artifacts.updater.sha256,
  );

  const previousPointer = await store.getObject(prepared.pointerKey);
  await store.putObject(prepared.pointerKey, prepared.pointerBytes, {
    contentType: 'application/json',
    cacheControl: 'no-store',
  });
  try {
    await verifyPromotedRelease(prepared, publicHttp);
  } catch (error) {
    try {
      if (previousPointer === null || previousPointer === undefined) {
        await store.deleteObject(prepared.pointerKey);
      } else {
        await store.putObject(prepared.pointerKey, previousPointer, {
          contentType: 'application/json',
          cacheControl: 'no-store',
        });
      }
    } catch (rollbackError) {
      throw new Error('Post-promotion verification failed and channel rollback also failed', {
        cause: new AggregateError([error, rollbackError]),
      });
    }
    throw new Error(`Post-promotion verification failed; the prior channel pointer was restored: ${error.message}`, {
      cause: error,
    });
  }
  logger.info(`[release] promoted ${prepared.channel} to ${prepared.version}`);
  return { ...prepared, dryRun: false, published: true };
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

function defaultRun(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function requireRun(run, command, args, message, options) {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(message);
  return result;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function assertVersionParity(repoRoot, version) {
  const desktopRoot = join(repoRoot, 'app', 'desktop');
  const [pkg, packageLock, tauri, cloudTauri, cargoToml, cargoLock, workspaceLock, releaseTest] = await Promise.all([
    readFile(join(desktopRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(desktopRoot, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(join(desktopRoot, 'src-tauri', 'tauri.conf.json'), 'utf8').then(JSON.parse),
    readFile(join(desktopRoot, 'src-tauri', 'tauri.cloud.conf.json'), 'utf8').then(JSON.parse),
    readFile(join(desktopRoot, 'src-tauri', 'Cargo.toml'), 'utf8'),
    readFile(join(desktopRoot, 'src-tauri', 'Cargo.lock'), 'utf8'),
    readFile(join(repoRoot, 'Cargo.lock'), 'utf8'),
    readFile(join(desktopRoot, 'tests', 'releaseVersion.test.mjs'), 'utf8'),
  ]);
  const escaped = escapeRegex(version);
  const releaseName = `V${version.replace(/-beta\./, '.beta')}`;
  const cargoPattern = new RegExp(`name = "kordi-desktop"\\nversion = "${escaped}"`);
  const checks = [
    [pkg.version === version, 'desktop package'],
    [packageLock.version === version && packageLock.packages?.['']?.version === version, 'desktop package lock'],
    [tauri.version === version, 'Tauri configuration'],
    [tauri.plugins?.updater?.pubkey === TAURI_UPDATER_PUBLIC_KEY, 'Tauri updater public key'],
    [JSON.stringify(tauri.plugins?.updater?.endpoints) === JSON.stringify([
      'https://coordinar.io/updates/desktop/{{target}}/{{arch}}/{{current_version}}',
    ]), 'Tauri updater endpoint'],
    [cloudTauri.version === undefined || cloudTauri.version === version, 'Cloud Tauri configuration'],
    [cargoPattern.test(cargoToml), 'desktop Cargo manifest'],
    [cargoPattern.test(cargoLock), 'desktop Cargo lock'],
    [cargoPattern.test(workspaceLock), 'workspace Cargo lock'],
    [releaseTest.includes(`const releaseName = '${releaseName}'`) && releaseTest.includes(`const appVersion = '${version}'`), 'release contract test'],
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) throw new Error(`${failed[1]} does not match release version ${version}`);
}

function assertAppVersion(run, appBundle, version) {
  const result = requireRun(
    run,
    'plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(appBundle, 'Contents', 'Info.plist')],
    'Unable to read Kordi.app version',
  );
  if (result.stdout.trim() !== version) throw new Error('Kordi.app version does not match release version');
}

function assertSignedApp(run, appBundle) {
  requireRun(run, 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle], 'codesign verification failed');
  requireRun(run, 'spctl', ['--assess', '--type', 'execute', '--verbose=2', appBundle], 'Gatekeeper assessment failed');
}

function scanAppBundle(run, appBundle) {
  const args = ['--text', '--hidden', '--no-messages', '-n'];
  for (const pattern of SENSITIVE_PATTERNS) args.push('-e', pattern);
  args.push(appBundle);
  const privacy = run('rg', args);
  if (privacy.status === 0) throw new Error('Release privacy scan found a forbidden value');
  if (privacy.status !== 1) throw new Error('Release privacy scan could not inspect the application bundle');
  requireRun(
    run,
    'rg',
    ['--text', '--hidden', '--no-messages', '-l', '-e', 'https://coordinar\\.io|coordinar\\.io', appBundle],
    'Application bundle does not contain the coordinar.io product origin',
  );
}

async function findAppBundle(root, depth = 0) {
  if (depth > 5) return null;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (entry.name === 'Kordi.app') return path;
    const nested = await findAppBundle(path, depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function inspectUpdaterArchive(run, updaterPath, version) {
  const listing = requireRun(run, 'tar', ['-tzf', updaterPath], 'Unable to inspect Tauri updater archive').stdout;
  for (const entry of listing.split(/\r?\n/).filter(Boolean)) {
    if (entry.startsWith('/') || entry.split('/').includes('..')) {
      throw new Error('Tauri updater archive contains an unsafe path');
    }
  }
  const extractDir = await mkdtemp(join(tmpdir(), 'kordi-updater-verify-'));
  try {
    requireRun(run, 'tar', ['-xzf', updaterPath, '-C', extractDir], 'Unable to extract Tauri updater archive');
    const archivedApp = await findAppBundle(extractDir);
    if (!archivedApp) throw new Error('Tauri updater archive does not contain Kordi.app');
    assertAppVersion(run, archivedApp, version);
    assertSignedApp(run, archivedApp);
    scanAppBundle(run, archivedApp);
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

export function createProductionVerifier({ repoRoot = REPO_ROOT, run = defaultRun, env = process.env } = {}) {
  return {
    async verify(input) {
      const status = requireRun(run, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], 'Unable to inspect release worktree', { cwd: repoRoot });
      if (status.stdout.trim()) throw new Error('Release worktree must be clean');
      const head = requireRun(run, 'git', ['rev-parse', 'HEAD'], 'Unable to read release commit', { cwd: repoRoot }).stdout.trim();
      if (head !== input.expectedCommit) throw new Error('Current commit does not match expected release commit');
      await assertVersionParity(repoRoot, input.version);

      if (!(env.TAURI_SIGNING_PRIVATE_KEY ?? '').trim() || !(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '').trim()) {
        throw new Error('Tauri updater signing key and password are required');
      }
      const identities = requireRun(run, 'security', ['find-identity', '-v', '-p', 'codesigning'], 'Unable to inspect macOS signing identities');
      const identityOutput = `${identities.stdout}\n${identities.stderr}`;
      const count = identityOutput.match(/(\d+) valid identities found/i);
      if (!/Developer ID Application:/i.test(identityOutput) || !count || Number(count[1]) < 1) {
        throw new Error('A valid Developer ID Application signing identity is required');
      }

      verifyTauriUpdaterSignature(input.updaterBytes, input.signature, input.updaterPublicKey);
      assertAppVersion(run, input.appBundle, input.version);
      assertSignedApp(run, input.appBundle);
      scanAppBundle(run, input.appBundle);
      await inspectUpdaterArchive(run, input.updaterPath, input.version);

      const mounted = mountDmg(input.manualPath);
      try {
        validateDmgVolumeLayout(mounted.mountPoint, { appName: 'Kordi' });
        const mountedApp = join(mounted.mountPoint, 'Kordi.app');
        assertAppVersion(run, mountedApp, input.version);
        assertSignedApp(run, mountedApp);
        scanAppBundle(run, mountedApp);
      } finally {
        detachDmg(mounted.device);
      }
    },
  };
}

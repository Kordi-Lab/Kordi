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
import {
  assertProductionSigningIdentity,
  verifyMacAppSignature,
} from './macos-release-signing.mjs';
import { assertMacOSNotificationBundleContract } from './macos-notification-release.mjs';
import {
  PRODUCT_ORIGIN,
  releaseUrlsForOrigin,
  verifyPromotedReleaseWithConvergence as verifyPromotedChannel,
  verifyPublicReleaseArtifacts,
  verifyUnpublishedChannelWithConvergence as verifyUnpublishedChannel,
} from './desktop-release-public.mjs';
import { releaseNotesForPublication } from './desktop-release-notes.mjs';

export { PRODUCT_ORIGIN } from './desktop-release-public.mjs';
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
  const releaseProfile = options?.releaseProfile ?? 'production';
  const expectedCommit = requireString(options?.expectedCommit, '--expected-commit');
  const pubDate = options?.pubDate === undefined
    ? new Date().toISOString()
    : requireString(options.pubDate, '--pub-date');
  if (!VERSION_PATTERN.test(version)) throw new Error('Release version must be a beta semantic version');
  if (!SAFE_CHANNELS.has(channel)) throw new Error('Release channel must be beta or acceptance');
  if (!['production', 'adhoc-preview'].includes(releaseProfile)) {
    throw new Error('Release profile must be production or adhoc-preview');
  }
  if (releaseProfile === 'adhoc-preview' && channel !== 'acceptance') {
    throw new Error('Ad-hoc preview releases may publish only to acceptance');
  }
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) throw new Error('Expected commit must be a full lowercase Git commit SHA');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(pubDate) || Number.isNaN(Date.parse(pubDate))) {
    throw new Error('Publication date must be an RFC 3339 UTC timestamp');
  }
  return {
    releaseDir,
    appBundle,
    version,
    channel,
    releaseProfile,
    expectedCommit,
    pubDate,
    releaseNotes: options?.releaseNotes,
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

  const verifier = dependencies.verifier ?? (
    normalized.releaseProfile === 'adhoc-preview'
      ? createAdhocPreviewVerifier()
      : createProductionVerifier()
  );
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

  const notes = await releaseNotesForPublication(normalized, join(REPO_ROOT, 'CHANGELOG.md'));
  const changelogUrl = normalized.releaseProfile === 'adhoc-preview'
    ? `https://github.com/Kordi-AI/Kordi/commit/${normalized.expectedCommit}`
    : `https://github.com/Kordi-AI/Kordi/releases/tag/V${normalized.version.replace(/-beta\./, '.beta')}`;
  const release = {
    schemaVersion: 1,
    version: normalized.version,
    notes,
    pubDate: normalized.pubDate,
    changelogUrl,
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
  const urls = releaseUrlsForOrigin({
    origin: PRODUCT_ORIGIN,
    version: normalized.version,
    manualName,
    updaterName,
    updaterEndpointPath,
  });
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

function storedObject(value, label) {
  if (!value || typeof value !== 'object' || value.bytes === undefined) {
    throw new Error(`${label} did not include bytes and an ETag`);
  }
  const bytes = Buffer.from(value.bytes);
  const etag = requireString(value.etag, `${label} ETag`);
  if (/[\r\n]/.test(etag)) throw new Error(`${label} ETag is invalid`);
  return { bytes, etag, versionId: value.versionId ?? null };
}

function unpublishedChannelPointerBytes(channel) {
  if (!SAFE_CHANNELS.has(channel)) throw new Error('Release channel must be beta or acceptance');
  return jsonBytes({ schemaVersion: 1, channel, unpublished: true });
}

function pointerRecordMatches(record, expected) {
  if (!expected) return record === null || record === undefined;
  return Boolean(
    record
    && record.etag === expected.pointerEtag
    && safeEqual(record.bytes, expected.pointerBytes),
  );
}

async function putChannelPointer(store, {
  key,
  bytes,
  previous,
  label,
  attempts = 3,
}) {
  let lastMutationError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await store.putObject(key, bytes, {
        contentType: 'application/json',
        cacheControl: 'no-store',
        ...(previous ? { ifMatch: previous.pointerEtag } : { ifNoneMatch: '*' }),
      });
      const etag = typeof result?.etag === 'string' && result.etag.trim()
        ? result.etag.trim()
        : null;
      if (etag && !/[\r\n]/.test(etag)) {
        return { bytes: Buffer.from(bytes), etag, versionId: result?.versionId ?? null };
      }
      lastMutationError = new Error(`${label} response did not include a valid ETag`);
    } catch (error) {
      lastMutationError = error;
    }

    let current;
    try {
      const value = await store.getObject(key);
      current = value === null || value === undefined ? null : storedObject(value, `${label} reconciliation`);
    } catch (reconciliationError) {
      throw new Error(`${label} outcome is ambiguous because read-back failed`, {
        cause: new AggregateError([lastMutationError, reconciliationError]),
      });
    }
    if (current && safeEqual(current.bytes, bytes)) {
      return current;
    }
    if (pointerRecordMatches(current, previous)) {
      if (attempt < attempts) continue;
      throw new Error(`${label} was not committed after ${attempts} attempts`, {
        cause: lastMutationError,
      });
    }
    throw new Error(`${label} could not be reconciled because the channel changed concurrently`, {
      cause: lastMutationError,
    });
  }
  throw new Error(`${label} could not be committed`, { cause: lastMutationError });
}

async function requireCurrentPointer(store, key, expected, label) {
  const current = storedObject(await store.getObject(key), label);
  if (current.etag !== expected.etag || !safeEqual(current.bytes, expected.bytes)) {
    throw new Error(`${label} does not match the requested channel state`);
  }
  return current;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an invalid schema`);
  }
}

function parseStoredJson(record, label) {
  let value;
  try {
    value = JSON.parse(record.bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} SHA-256 is invalid`);
  }
}

function validateStoredAsset(asset, version, { updater }) {
  const keys = ['objectKey', 'fileName', 'contentType', 'sha256', 'sizeBytes'];
  if (updater) keys.push('signature');
  assertExactKeys(asset, keys, updater ? 'Prior updater asset' : 'Prior manual asset');
  const expectedName = updater ? 'Kordi.app.tar.gz' : `Kordi_${version}_aarch64.dmg`;
  if (asset.fileName !== expectedName) throw new Error('Prior release asset filename is invalid');
  if (asset.objectKey !== `desktop/releases/${version}/macos/aarch64/${expectedName}`) {
    throw new Error('Prior release asset key is invalid');
  }
  const expectedContentType = updater ? 'application/gzip' : 'application/x-apple-diskimage';
  if (asset.contentType !== expectedContentType) throw new Error('Prior release asset content type is invalid');
  assertDigest(asset.sha256, 'Prior release asset');
  if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0) {
    throw new Error('Prior release asset size is invalid');
  }
  if (updater) assertSignatureShape(asset.signature);
}

function validateStoredRelease(value, expectedKey) {
  assertExactKeys(
    value,
    ['schemaVersion', 'version', 'notes', 'pubDate', 'changelogUrl', 'manual', 'platforms'],
    'Prior release manifest',
  );
  if (value.schemaVersion !== 1 || !VERSION_PATTERN.test(value.version)) {
    throw new Error('Prior release manifest version is invalid');
  }
  if (expectedKey !== `desktop/releases/${value.version}/release.json`) {
    throw new Error('Prior release manifest key does not match its version');
  }
  if (typeof value.notes !== 'string' || !value.notes.trim() || value.notes.length > 16_384) {
    throw new Error('Prior release notes are invalid');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.pubDate) || Number.isNaN(Date.parse(value.pubDate))) {
    throw new Error('Prior release publication date is invalid');
  }
  let changelog;
  try {
    changelog = new URL(value.changelogUrl);
  } catch {
    throw new Error('Prior release changelog URL is invalid');
  }
  if (changelog.protocol !== 'https:' || changelog.username || changelog.password) {
    throw new Error('Prior release changelog URL is invalid');
  }
  assertExactKeys(value.platforms, ['darwin-aarch64'], 'Prior release platforms');
  validateStoredAsset(value.manual, value.version, { updater: false });
  validateStoredAsset(value.platforms['darwin-aarch64'], value.version, { updater: true });
  return value;
}

async function loadChannelSnapshot(store, channel, updaterPublicKey = TAURI_UPDATER_PUBLIC_KEY) {
  if (!SAFE_CHANNELS.has(channel)) throw new Error('Release channel must be beta or acceptance');
  const pointerKey = `desktop/channels/${channel}/latest.json`;
  const rawPointer = await store.getObject(pointerKey);
  if (rawPointer === null || rawPointer === undefined) return null;
  const pointerRecord = storedObject(rawPointer, 'Prior channel pointer');
  const pointer = parseStoredJson(pointerRecord, 'Prior channel pointer');
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) {
    throw new Error('Prior channel pointer must be an object');
  }
  if (Object.hasOwn(pointer, 'unpublished')) {
    assertExactKeys(
      pointer,
      ['schemaVersion', 'channel', 'unpublished'],
      'Prior unpublished channel pointer',
    );
    if (pointer.schemaVersion !== 1 || pointer.channel !== channel || pointer.unpublished !== true) {
      throw new Error('Prior unpublished channel pointer is invalid');
    }
    return {
      channel,
      pointerKey,
      pointerBytes: pointerRecord.bytes,
      pointerEtag: pointerRecord.etag,
      unpublished: true,
    };
  }
  assertExactKeys(
    pointer,
    ['schemaVersion', 'channel', 'releaseManifestKey', 'releaseManifestSha256'],
    'Prior channel pointer',
  );
  if (pointer.schemaVersion !== 1 || pointer.channel !== channel) {
    throw new Error('Prior channel pointer is invalid');
  }
  assertDigest(pointer.releaseManifestSha256, 'Prior channel pointer manifest');
  if (!/^desktop\/releases\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.(?:0|[1-9]\d*)\/release\.json$/.test(pointer.releaseManifestKey)) {
    throw new Error('Prior channel pointer manifest key is invalid');
  }

  const rawManifest = await store.getObject(pointer.releaseManifestKey);
  if (rawManifest === null || rawManifest === undefined) {
    throw new Error('Prior channel pointer references a missing release manifest');
  }
  const manifestRecord = storedObject(rawManifest, 'Prior release manifest');
  if (sha256(manifestRecord.bytes) !== pointer.releaseManifestSha256) {
    throw new Error('Prior channel pointer manifest digest is invalid');
  }
  const release = validateStoredRelease(
    parseStoredJson(manifestRecord, 'Prior release manifest'),
    pointer.releaseManifestKey,
  );
  const updaterAsset = release.platforms['darwin-aarch64'];
  const rawManual = await store.getObject(release.manual.objectKey);
  const rawUpdater = await store.getObject(updaterAsset.objectKey);
  if (rawManual === null || rawManual === undefined || rawUpdater === null || rawUpdater === undefined) {
    throw new Error('Prior channel pointer references a missing release artifact');
  }
  const manualRecord = storedObject(rawManual, 'Prior manual release artifact');
  const updaterRecord = storedObject(rawUpdater, 'Prior updater release artifact');
  for (const [record, asset] of [[manualRecord, release.manual], [updaterRecord, updaterAsset]]) {
    if (record.bytes.length !== asset.sizeBytes || sha256(record.bytes) !== asset.sha256) {
      throw new Error('Prior channel pointer references a corrupt release artifact');
    }
  }
  verifyTauriUpdaterSignature(updaterRecord.bytes, updaterAsset.signature, updaterPublicKey);
  const updaterEndpointPath = channel === 'acceptance'
    ? '/updates/desktop/acceptance/darwin/aarch64/0.0.0'
    : '/updates/desktop/darwin/aarch64/0.0.0';
  return {
    channel,
    pointerKey,
    pointerBytes: pointerRecord.bytes,
    pointerEtag: pointerRecord.etag,
    unpublished: false,
    version: release.version,
    pubDate: release.pubDate,
    release,
    artifacts: {
      manual: { bytes: manualRecord.bytes, sha256: release.manual.sha256 },
      updater: { bytes: updaterRecord.bytes, sha256: updaterAsset.sha256 },
    },
    urls: releaseUrlsForOrigin({
      origin: PRODUCT_ORIGIN,
      version: release.version,
      manualName: release.manual.fileName,
      updaterName: updaterAsset.fileName,
      updaterEndpointPath,
    }),
  };
}

export async function clearDesktopReleaseChannel(options, dependencies = {}) {
  const channel = requireString(options?.channel, '--channel');
  if (channel !== 'acceptance') {
    throw new Error('Only the acceptance channel can be cleared by this release command');
  }
  const { store, publicHttp } = dependencies;
  if (!store || typeof store.getObject !== 'function' || typeof store.putObject !== 'function') {
    throw new Error('A release object store adapter is required');
  }
  if (!publicHttp || typeof publicHttp.get !== 'function' || typeof publicHttp.head !== 'function') {
    throw new Error('A public HTTP verification adapter is required');
  }
  const logger = dependencies.logger ?? { info() {} };
  const previous = await loadChannelSnapshot(
    store,
    channel,
    dependencies.updaterPublicKey ?? TAURI_UPDATER_PUBLIC_KEY,
  );
  if (!previous || previous.unpublished) {
    await verifyUnpublishedChannel(channel, publicHttp, VERSION_PATTERN);
    logger.info('[release] acceptance channel already unpublished');
    return { channel, removed: false };
  }

  const tombstoneBytes = unpublishedChannelPointerBytes(channel);
  let tombstone;
  try {
    tombstone = await putChannelPointer(store, {
      key: previous.pointerKey,
      bytes: tombstoneBytes,
      previous,
      label: 'Acceptance channel tombstone',
    });
    await requireCurrentPointer(
      store,
      previous.pointerKey,
      tombstone,
      'Acceptance channel tombstone',
    );
    await verifyUnpublishedChannel(channel, publicHttp, VERSION_PATTERN);
  } catch (error) {
    if (!tombstone) throw error;
    try {
      const restored = await putChannelPointer(store, {
        key: previous.pointerKey,
        bytes: previous.pointerBytes,
        previous: {
          pointerBytes: tombstone.bytes,
          pointerEtag: tombstone.etag,
        },
        label: 'Acceptance channel pointer restoration',
      });
      await requireCurrentPointer(
        store,
        previous.pointerKey,
        restored,
        'Restored acceptance channel pointer',
      );
      await verifyPromotedChannel(previous, publicHttp);
    } catch (rollbackError) {
      throw new Error('Acceptance cleanup verification failed and pointer restoration also failed', {
        cause: new AggregateError([error, rollbackError]),
      });
    }
    throw new Error(`Acceptance cleanup verification failed; the prior pointer was restored: ${error.message}`, {
      cause: error,
    });
  }
  logger.info('[release] acceptance channel unpublished and verified');
  return { channel, removed: true };
}

export async function rollbackDesktopBetaChannel(options, dependencies = {}) {
  const expectedCurrentVersion = requireString(
    options?.expectedCurrentVersion,
    '--expected-current-version',
  );
  if (!VERSION_PATTERN.test(expectedCurrentVersion)) {
    throw new Error('Expected current version must be a beta semantic version');
  }
  const { store } = dependencies;
  if (!store || typeof store.getObject !== 'function' || typeof store.putObject !== 'function') {
    throw new Error('A release object store adapter is required');
  }
  const previous = await loadChannelSnapshot(
    store,
    'beta',
    dependencies.updaterPublicKey ?? TAURI_UPDATER_PUBLIC_KEY,
  );
  if (!previous || previous.unpublished) throw new Error('The beta channel is already unpublished');
  if (previous.version !== expectedCurrentVersion) {
    throw new Error(
      `Expected beta channel ${expectedCurrentVersion}, but storage currently references ${previous.version}`,
    );
  }
  const { publicHttp } = dependencies;
  if (!publicHttp || typeof publicHttp.get !== 'function' || typeof publicHttp.head !== 'function') {
    throw new Error('A public HTTP verification adapter is required');
  }
  const logger = dependencies.logger ?? { info() {} };

  const tombstoneBytes = unpublishedChannelPointerBytes('beta');
  let tombstone;
  try {
    tombstone = await putChannelPointer(store, {
      key: previous.pointerKey,
      bytes: tombstoneBytes,
      previous,
      label: 'Beta channel tombstone',
    });
    await requireCurrentPointer(store, previous.pointerKey, tombstone, 'Beta channel tombstone');
    await verifyUnpublishedChannel('beta', publicHttp, VERSION_PATTERN);
  } catch (error) {
    if (!tombstone) throw error;
    try {
      const restored = await putChannelPointer(store, {
        key: previous.pointerKey,
        bytes: previous.pointerBytes,
        previous: {
          pointerBytes: tombstone.bytes,
          pointerEtag: tombstone.etag,
        },
        label: 'Beta channel pointer restoration',
      });
      await requireCurrentPointer(
        store,
        previous.pointerKey,
        restored,
        'Restored beta channel pointer',
      );
      await verifyPromotedChannel(previous, publicHttp);
    } catch (rollbackError) {
      throw new Error('Beta rollback verification failed and pointer restoration also failed', {
        cause: new AggregateError([error, rollbackError]),
      });
    }
    throw new Error(`Beta rollback verification failed; the ${previous.version} pointer was restored: ${error.message}`, {
      cause: error,
    });
  }
  logger.info(`[release] beta channel ${expectedCurrentVersion} unpublished and fallback verified`);
  return { removedVersion: expectedCurrentVersion };
}

export async function publishDesktopRelease(options, dependencies = {}) {
  const prepared = await prepareDesktopRelease(options, dependencies);
  const logger = dependencies.logger ?? { info() {} };
  if (prepared.dryRun) {
    logger.info(`[release] dry-run verified ${prepared.version} (${prepared.channel})`);
    return { ...prepared, dryRun: true, published: false };
  }
  const { store, publicHttp } = dependencies;
  if (!store || typeof store.getObject !== 'function' || typeof store.putObject !== 'function') {
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
    } else if (!safeEqual(storedObject(existing, `Immutable object ${object.key}`).bytes, object.bytes)) {
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

  await verifyPublicReleaseArtifacts(prepared, publicHttp);

  const previous = await loadChannelSnapshot(
    store,
    prepared.channel,
    dependencies.updaterPublicKey ?? TAURI_UPDATER_PUBLIC_KEY,
  );
  let promotion;
  try {
    promotion = await putChannelPointer(store, {
      key: prepared.pointerKey,
      bytes: prepared.pointerBytes,
      previous,
      label: 'Channel pointer promotion',
    });
    await requireCurrentPointer(
      store,
      prepared.pointerKey,
      promotion,
      'Promoted channel pointer',
    );
    await verifyPromotedChannel(prepared, publicHttp);
  } catch (error) {
    if (!promotion) throw error;
    try {
      const restoreBytes = previous?.pointerBytes
        ?? unpublishedChannelPointerBytes(prepared.channel);
      const restored = await putChannelPointer(store, {
        key: prepared.pointerKey,
        bytes: restoreBytes,
        previous: {
          pointerBytes: promotion.bytes,
          pointerEtag: promotion.etag,
        },
        label: 'Channel pointer rollback',
      });
      await requireCurrentPointer(store, prepared.pointerKey, restored, 'Restored channel pointer');
      if (previous && !previous.unpublished) {
        await verifyPromotedChannel(previous, publicHttp);
      } else {
        await verifyUnpublishedChannel(prepared.channel, publicHttp, VERSION_PATTERN);
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
      'https://kordi.ai/updates/desktop/{{target}}/{{arch}}/{{current_version}}',
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

async function assertAcceptanceConfigParity(repoRoot) {
  const tauriRoot = join(repoRoot, 'app', 'desktop', 'src-tauri');
  const [target, bootstrap] = await Promise.all([
    readFile(join(tauriRoot, 'tauri.cloud.acceptance.conf.json'), 'utf8').then(JSON.parse),
    readFile(join(tauriRoot, 'tauri.cloud.acceptance-bootstrap.conf.json'), 'utf8').then(JSON.parse),
  ]);
  const endpoint = 'https://kordi.ai/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}';
  for (const config of [target, bootstrap]) {
    if (
      config.productName !== 'Kordi'
      || config.identifier !== 'io.kordi.cloud'
      || config.bundle?.macOS?.signingIdentity !== '-'
      || config.plugins?.updater?.pubkey !== undefined
      || JSON.stringify(config.plugins?.updater?.endpoints) !== JSON.stringify([endpoint])
    ) {
      throw new Error('Acceptance Tauri configuration does not match the ad-hoc preview contract');
    }
  }
  if (target.version !== undefined || bootstrap.version !== '0.0.1-beta.5.1') {
    throw new Error('Acceptance Tauri versions do not match the preview contract');
  }
}

export function assertAppBundleContract(run, appBundle, {
  version,
  identifier = 'io.kordi.cloud',
  releaseProfile,
}) {
  const plist = (key) => requireRun(
    run,
    'plutil',
    ['-extract', key, 'raw', '-o', '-', join(appBundle, 'Contents', 'Info.plist')],
    `Unable to read Kordi.app ${key}`,
  ).stdout.trim();
  if (plist('CFBundleShortVersionString') !== version) {
    throw new Error('Kordi.app version does not match release version');
  }
  if (plist('CFBundleIdentifier') !== identifier) {
    throw new Error('Kordi.app identifier does not match the Cloud product identifier');
  }
  const trust = verifyMacAppSignature({ run, appBundle, profile: releaseProfile });
  const acceptanceEndpoint =
    'https://kordi.ai/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}';
  const productionEndpoint =
    'https://kordi.ai/updates/desktop/{{target}}/{{arch}}/{{current_version}}';
  const endpoint = releaseProfile === 'adhoc-preview' ? acceptanceEndpoint : productionEndpoint;
  const forbiddenEndpoint = releaseProfile === 'adhoc-preview' ? productionEndpoint : acceptanceEndpoint;
  requireRun(
    run,
    'rg',
    ['--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F', endpoint, appBundle],
    'Application bundle does not contain the updater endpoint required by its release profile',
  );
  const forbidden = run('rg', [
    '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F', forbiddenEndpoint, appBundle,
  ]);
  if (forbidden?.status === 0) {
    throw new Error('Application bundle violates updater endpoint profile isolation');
  }
  if (forbidden?.status !== 1) {
    throw new Error('Unable to inspect application bundle updater-endpoint profile isolation');
  }
  assertMacOSNotificationBundleContract(run, appBundle);
  return trust;
}

export function releaseTreeScanArguments(root) {
  const args = ['--text', '--hidden', '--no-ignore', '--no-messages', '-n'];
  for (const pattern of SENSITIVE_PATTERNS) args.push('-e', pattern);
  args.push(root);
  return args;
}

export function productOriginScanArguments(root) {
  return ['--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F', PRODUCT_ORIGIN, root];
}

function scanReleaseTree(run, root) {
  const args = releaseTreeScanArguments(root);
  const privacy = run('rg', args);
  if (privacy.status === 0) throw new Error('Release privacy scan found a forbidden value');
  if (privacy.status !== 1) throw new Error('Release privacy scan could not inspect the application bundle');
  requireRun(
    run,
    'rg',
    productOriginScanArguments(root),
    'Application bundle does not contain the kordi.ai product origin',
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

async function inspectUpdaterArchive(run, updaterPath, version, verifyBundle) {
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
    await verifyBundle(archivedApp, version);
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

function createArtifactVerifier({
  releaseProfile,
  repoRoot = REPO_ROOT,
  run = defaultRun,
  env = process.env,
  mountDmgImpl = mountDmg,
  detachDmgImpl = detachDmg,
  validateDmgVolumeLayoutImpl = validateDmgVolumeLayout,
  inspectUpdaterArchiveImpl = inspectUpdaterArchive,
}) {
  return {
    async verify(input) {
      const status = requireRun(run, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], 'Unable to inspect release worktree', { cwd: repoRoot });
      if (status.stdout.trim()) throw new Error('Release worktree must be clean');
      const head = requireRun(run, 'git', ['rev-parse', 'HEAD'], 'Unable to read release commit', { cwd: repoRoot }).stdout.trim();
      if (head !== input.expectedCommit) throw new Error('Current commit does not match expected release commit');
      await assertVersionParity(repoRoot, input.version);
      if (releaseProfile === 'adhoc-preview') await assertAcceptanceConfigParity(repoRoot);

      if (!(env.TAURI_SIGNING_PRIVATE_KEY ?? '').trim() || !(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '').trim()) {
        throw new Error('Tauri updater signing key and password are required');
      }
      if (releaseProfile === 'production') assertProductionSigningIdentity(run);

      verifyTauriUpdaterSignature(input.updaterBytes, input.signature, input.updaterPublicKey);
      const verifyBundle = (appBundle) => {
        assertAppBundleContract(run, appBundle, {
          version: input.version,
          identifier: 'io.kordi.cloud',
          releaseProfile,
        });
        scanReleaseTree(run, appBundle);
      };
      verifyBundle(input.appBundle);
      await inspectUpdaterArchiveImpl(run, input.updaterPath, input.version, verifyBundle);

      const mounted = mountDmgImpl(input.manualPath);
      try {
        validateDmgVolumeLayoutImpl(mounted.mountPoint, { appName: 'Kordi' });
        const mountedApp = join(mounted.mountPoint, 'Kordi.app');
        verifyBundle(mountedApp);
        scanReleaseTree(run, mounted.mountPoint);
      } finally {
        detachDmgImpl(mounted.device);
      }
    },
  };
}

export function createProductionVerifier(options = {}) {
  return createArtifactVerifier({ ...options, releaseProfile: 'production' });
}

export function createAdhocPreviewVerifier(options = {}) {
  return createArtifactVerifier({ ...options, releaseProfile: 'adhoc-preview' });
}

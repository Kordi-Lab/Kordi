import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LEGACY_RELEASE_ORIGIN,
  PRODUCT_ORIGIN,
  PUBLIC_RELEASE_ORIGINS,
  TAURI_UPDATER_PUBLIC_KEY,
  assertAppBundleContract,
  clearDesktopReleaseChannel,
  createAdhocPreviewVerifier,
  createProductionVerifier,
  prepareDesktopRelease,
  productOriginScanArguments,
  publishDesktopRelease,
  redactPublisherText,
  releaseTreeScanArguments,
  rollbackDesktopBetaChannel,
  verifyTauriUpdaterSignature,
} from '../lib/desktop-release.mjs';
import {
  createPublicHttpAdapter,
  createS3ReleaseStore,
  parsePublisherArguments,
} from '../publish-desktop-release.mjs';

export const VERSION = '0.0.1-beta.6';
export const PREVIOUS_VERSION = '0.0.1-beta.5';
export const PUB_DATE = '2026-07-13T00:00:00Z';
export const TEST_PUBLIC_KEY_TEXT = [
  'untrusted comment: minisign public key E7620F1842B4E81F',
  'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3',
].join('\n');
export const TEST_SIGNATURE_TEXT = [
  'untrusted comment: signature from minisign secret key',
  'RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=',
  'trusted comment: timestamp:1556193335\tfile:test',
  'y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==',
].join('\n');
export const TEST_SIGNATURE = Buffer.from(TEST_SIGNATURE_TEXT).toString('base64');
export const TEST_PUBLIC_KEY = Buffer.from(TEST_PUBLIC_KEY_TEXT).toString('base64');
export const APP_CONTRACT_BUNDLE = '/tmp/Kordi.app';
export const ACCEPTANCE_ENDPOINT =
  'https://kordi.ai/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}';
export const PRODUCTION_ENDPOINT =
  'https://kordi.ai/updates/desktop/{{target}}/{{arch}}/{{current_version}}';

export function contractRun(overrides = new Map(), calls = []) {
  const info = `${APP_CONTRACT_BUNDLE}/Contents/Info.plist`;
  const results = new Map([
    [`plutil -extract CFBundleShortVersionString raw -o - ${info}`, {
      status: 0, stdout: `${VERSION}\n`, stderr: '',
    }],
    [`plutil -extract CFBundleIdentifier raw -o - ${info}`, {
      status: 0, stdout: 'io.kordi.cloud\n', stderr: '',
    }],
    [`codesign --verify --deep --strict --verbose=2 ${APP_CONTRACT_BUNDLE}`, {
      status: 0, stdout: '', stderr: '',
    }],
    [`codesign --display --verbose=4 ${APP_CONTRACT_BUNDLE}`, {
      status: 0, stdout: '', stderr: 'Signature=adhoc\nTeamIdentifier=not set\n',
    }],
    [`spctl --assess --type execute --verbose=2 ${APP_CONTRACT_BUNDLE}`, {
      status: 1, stdout: '', stderr: 'rejected',
    }],
    [[
      'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
      ACCEPTANCE_ENDPOINT, APP_CONTRACT_BUNDLE,
    ].join(' '), {
      status: 0,
      stdout: `${APP_CONTRACT_BUNDLE}/Contents/MacOS/Kordi\n`,
      stderr: '',
    }],
    [[
      'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
      PRODUCTION_ENDPOINT, APP_CONTRACT_BUNDLE,
    ].join(' '), {
      status: 1,
      stdout: '',
      stderr: '',
    }],
    ...overrides,
  ]);
  return (command, args = []) => {
    const key = [command, ...args].join(' ');
    calls.push(key);
    return results.get(key)
      ?? { status: 1, stdout: '', stderr: `unexpected command: ${key}` };
  };
}

export async function makeVerifierRepoFixture() {
  const root = await mkdtemp(join(tmpdir(), 'kordi-verifier-repo-test-'));
  const desktopRoot = join(root, 'app', 'desktop');
  const tauriRoot = join(desktopRoot, 'src-tauri');
  await mkdir(join(desktopRoot, 'tests'), { recursive: true });
  await mkdir(tauriRoot, { recursive: true });
  const packageLock = { version: VERSION, packages: { '': { version: VERSION } } };
  const cargoVersion = `name = "kordi-desktop"\nversion = "${VERSION}"\n`;
  const acceptanceConfig = {
    productName: 'Kordi',
    identifier: 'io.kordi.cloud',
    bundle: { macOS: { signingIdentity: '-' } },
    plugins: { updater: { endpoints: [ACCEPTANCE_ENDPOINT] } },
  };
  await Promise.all([
    writeFile(join(desktopRoot, 'package.json'), JSON.stringify({ version: VERSION })),
    writeFile(join(desktopRoot, 'package-lock.json'), JSON.stringify(packageLock)),
    writeFile(join(tauriRoot, 'tauri.conf.json'), JSON.stringify({
      version: VERSION,
      plugins: { updater: { pubkey: TAURI_UPDATER_PUBLIC_KEY, endpoints: [PRODUCTION_ENDPOINT] } },
    })),
    writeFile(join(tauriRoot, 'tauri.cloud.conf.json'), JSON.stringify({ identifier: 'io.kordi.cloud' })),
    writeFile(join(tauriRoot, 'tauri.cloud.acceptance.conf.json'), JSON.stringify(acceptanceConfig)),
    writeFile(join(tauriRoot, 'tauri.cloud.acceptance-bootstrap.conf.json'), JSON.stringify({
      ...acceptanceConfig,
      version: '0.0.1-beta.5.1',
    })),
    writeFile(join(tauriRoot, 'Cargo.toml'), cargoVersion),
    writeFile(join(tauriRoot, 'Cargo.lock'), cargoVersion),
    writeFile(join(root, 'Cargo.lock'), cargoVersion),
    writeFile(
      join(desktopRoot, 'tests', 'releaseVersion.test.mjs'),
      `const releaseName = 'V0.0.1.beta6';\nconst appVersion = '${VERSION}';\n`,
    ),
  ]);
  return root;
}

export function artifactVerifierRun(releaseProfile, calls) {
  const expectedEndpoint = releaseProfile === 'adhoc-preview'
    ? ACCEPTANCE_ENDPOINT
    : PRODUCTION_ENDPOINT;
  return (command, args = []) => {
    const key = [command, ...args].join(' ');
    calls.push(key);
    if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'rev-parse') {
      return { status: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
    }
    if (command === 'security') {
      return {
        status: 0,
        stdout: '1) ABC "Developer ID Application: Example (TEAMID)"\n1 valid identities found\n',
        stderr: '',
      };
    }
    if (command === 'plutil' && args[1] === 'CFBundleShortVersionString') {
      return { status: 0, stdout: `${VERSION}\n`, stderr: '' };
    }
    if (command === 'plutil' && args[1] === 'CFBundleIdentifier') {
      return { status: 0, stdout: 'io.kordi.cloud\n', stderr: '' };
    }
    if (command === 'codesign' && args[0] === '--verify') return { status: 0, stdout: '', stderr: '' };
    if (command === 'codesign' && args[0] === '--display') {
      return { status: 0, stdout: '', stderr: 'Signature=adhoc\nTeamIdentifier=not set\n' };
    }
    if (command === 'spctl') {
      return { status: releaseProfile === 'production' ? 0 : 1, stdout: '', stderr: 'rejected' };
    }
    if (command === 'rg' && args.includes('-n')) return { status: 1, stdout: '', stderr: '' };
    if (command === 'rg' && args.includes('-F')) {
      return {
        status: args.includes(expectedEndpoint) || args.includes(PRODUCT_ORIGIN) ? 0 : 1,
        stdout: 'Kordi\n',
        stderr: '',
      };
    }
    if (command === 'rg' && args.includes('-e')) return { status: 0, stdout: 'Kordi\n', stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected command: ${key}` };
  };
}

export async function makeFixture(version = VERSION) {
  const root = await mkdtemp(join(tmpdir(), 'kordi-publisher-test-'));
  const releaseDir = join(root, 'release');
  const appBundle = join(root, 'Kordi.app');
  await mkdir(releaseDir);
  await mkdir(join(appBundle, 'Contents'), { recursive: true });
  const dmgName = `Kordi_${version}_aarch64.dmg`;
  const archiveName = 'Kordi.app.tar.gz';
  const signatureName = `${archiveName}.sig`;
  const dmg = Buffer.from('signed notarized dmg fixture');
  const archive = Buffer.from('test');
  const signature = Buffer.from(`${TEST_SIGNATURE}\n`);
  await writeFile(join(releaseDir, dmgName), dmg);
  await writeFile(join(releaseDir, archiveName), archive);
  await writeFile(join(releaseDir, signatureName), signature);
  return {
    root,
    releaseDir,
    appBundle,
    dmgName,
    archiveName,
    signatureName,
    dmg,
    archive,
    signature,
  };
}

export function optionsFor(fixture, overrides = {}) {
  return {
    releaseDir: fixture.releaseDir,
    appBundle: fixture.appBundle,
    version: VERSION,
    channel: 'beta',
    expectedCommit: '0123456789abcdef0123456789abcdef01234567',
    pubDate: PUB_DATE,
    ...overrides,
  };
}

export function passingVerifier(calls = []) {
  return {
    async verify(input) {
      calls.push(input);
    },
  };
}

export class MemoryStore {
  constructor(entries = []) {
    this.revision = 0;
    this.objects = new Map(entries.map(([key, value]) => [key, this.#record(value)]));
    this.actions = [];
  }

  #record(value) {
    const bytes = Buffer.from(value?.bytes ?? value);
    const etag = value?.etag ?? `"memory-${createHash('sha256').update(bytes).digest('hex')}-${this.revision += 1}"`;
    return { bytes, etag, versionId: `memory-version-${this.revision}` };
  }

  async getObject(key) {
    this.actions.push({ type: 'get', key });
    const value = this.objects.get(key);
    return value === undefined ? null : { ...value, bytes: Buffer.from(value.bytes) };
  }

  async putObject(key, bytes, metadata) {
    const action = { type: 'put', key, metadata };
    this.actions.push(action);
    const current = this.objects.get(key);
    if (metadata?.ifNoneMatch === '*' && current) throw new Error(`precondition failed for ${key}`);
    if (metadata?.ifMatch && current?.etag !== metadata.ifMatch) throw new Error(`precondition failed for ${key}`);
    if (metadata?.ifMatch && !current) throw new Error(`precondition failed for ${key}`);
    const record = this.#record(bytes);
    this.objects.set(key, record);
    action.resultEtag = record.etag;
    return { etag: record.etag, versionId: record.versionId };
  }

  forcePut(key, bytes) {
    this.objects.set(key, this.#record(bytes));
  }

  bytes(key) {
    return this.objects.get(key)?.bytes;
  }
}

export function responseFor(bytes, digest, status = 200) {
  return {
    status,
    headers: {
      'content-length': String(bytes.length),
      'x-checksum-sha256': digest,
    },
    body: Buffer.from(bytes),
  };
}

export function makePublicHttp(prepared, {
  failPostPromotion = false,
  failLegacyPostPromotion = false,
  wrongArchive = false,
  previousPrepared = null,
  onPostPromotionFailure = null,
} = {}) {
  const actions = [];
  const publicUrlSets = (release) => [release.urls, release.legacyUrls];
  const byUrl = new Map();
  for (const urls of publicUrlSets(prepared)) {
    byUrl.set(urls.manual, {
      bytes: prepared.artifacts.manual.bytes,
      digest: prepared.artifacts.manual.sha256,
    });
    byUrl.set(urls.updaterArchive, {
      bytes: wrongArchive ? Buffer.from('tampered') : prepared.artifacts.updater.bytes,
      digest: prepared.artifacts.updater.sha256,
    });
  }
  if (previousPrepared) {
    for (const urls of publicUrlSets(previousPrepared)) {
      byUrl.set(urls.manual, {
        bytes: previousPrepared.artifacts.manual.bytes,
        digest: previousPrepared.artifacts.manual.sha256,
      });
      byUrl.set(urls.updaterArchive, {
        bytes: previousPrepared.artifacts.updater.bytes,
        digest: previousPrepared.artifacts.updater.sha256,
      });
    }
  }
  let postPromotionFailed = false;
  const updateResponse = (release) => Buffer.from(JSON.stringify({
    version: release.version,
    notes: release.release.notes,
    pub_date: release.pubDate,
    url: release.urls.updaterArchive,
    signature: release.release.platforms['darwin-aarch64'].signature,
  }));
  const stableAsset = () => (postPromotionFailed ? previousPrepared?.artifacts.manual : prepared.artifacts.manual);
  return {
    actions,
    async head(url) {
      actions.push({ method: 'HEAD', url });
      if (publicUrlSets(prepared).some((urls) => url === urls.stableManual)) {
        const found = stableAsset();
        return found ? responseFor(found.bytes, found.sha256) : { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      const found = byUrl.get(url);
      return found ? responseFor(found.bytes, found.digest) : { status: 404, headers: {}, body: Buffer.alloc(0) };
    },
    async get(url) {
      actions.push({ method: 'GET', url });
      if (publicUrlSets(prepared).some((urls) => url === urls.updaterEndpoint)) {
        const shouldFailPostPromotion = !postPromotionFailed && (
          failPostPromotion
          || (failLegacyPostPromotion && url === prepared.legacyUrls.updaterEndpoint)
        );
        if (shouldFailPostPromotion) {
          postPromotionFailed = true;
          onPostPromotionFailure?.();
          return { status: 503, headers: {}, body: Buffer.from('unavailable') };
        }
        const selected = postPromotionFailed ? previousPrepared : prepared;
        if (!selected) return { status: 204, headers: {}, body: Buffer.alloc(0) };
        const updateBody = updateResponse(selected);
        return { status: 200, headers: { 'content-length': String(updateBody.length) }, body: updateBody };
      }
      if (
        PUBLIC_RELEASE_ORIGINS.some((origin) => url === `${origin}/updates/releases/version`)
        && postPromotionFailed
        && !previousPrepared
      ) {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({
            version: '0.0.1-beta.5',
            changelogUrl: 'https://kordi.ai/updates/releases/version',
          })),
        };
      }
      if (publicUrlSets(prepared).some((urls) => url === urls.stableManual)) {
        const found = stableAsset();
        return found ? responseFor(found.bytes, found.sha256) : { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      const found = byUrl.get(url);
      return found ? responseFor(found.bytes, found.digest) : { status: 404, headers: {}, body: Buffer.alloc(0) };
    },
  };
}

export function storedReleaseEntries(prepared, { includePointer = true } = {}) {
  const entries = prepared.immutableObjects.map((object) => [object.key, object.bytes]);
  if (includePointer) entries.push([prepared.pointerKey, prepared.pointerBytes]);
  return entries;
}

export function tombstoneBytes(channel) {
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, channel, unpublished: true }, null, 2)}\n`);
}

export async function preparedFixture(fixture, overrides = {}) {
  return prepareDesktopRelease(optionsFor(fixture, overrides), {
    verifier: passingVerifier(),
  });
}

export {
  assert,
  readFile,
  rm,
  writeFile,
  join,
  test,
  LEGACY_RELEASE_ORIGIN,
  PRODUCT_ORIGIN,
  PUBLIC_RELEASE_ORIGINS,
  TAURI_UPDATER_PUBLIC_KEY,
  assertAppBundleContract,
  clearDesktopReleaseChannel,
  createAdhocPreviewVerifier,
  createProductionVerifier,
  prepareDesktopRelease,
  productOriginScanArguments,
  publishDesktopRelease,
  redactPublisherText,
  releaseTreeScanArguments,
  rollbackDesktopBetaChannel,
  verifyTauriUpdaterSignature,
  createS3ReleaseStore,
  createPublicHttpAdapter,
  parsePublisherArguments,
};

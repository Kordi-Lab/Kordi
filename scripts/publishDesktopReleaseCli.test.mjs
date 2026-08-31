import {
  assert,
  readFile,
  rm,
  join,
  test,
  productOriginScanArguments,
  publishDesktopRelease,
  redactPublisherText,
  releaseTreeScanArguments,
  createS3ReleaseStore,
  createPublicHttpAdapter,
  parsePublisherArguments,
  VERSION,
  PUB_DATE,
  makeFixture,
  optionsFor,
  passingVerifier,
  MemoryStore,
} from './test_support/publishDesktopReleaseFixtures.mjs';

test('dry-run executes local validation and writes metadata without network mutation', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const verifierCalls = [];
  const store = new MemoryStore();
  const result = await publishDesktopRelease(optionsFor(fixture, { dryRun: true }), {
    verifier: passingVerifier(verifierCalls),
    store,
    publicHttp: { async get() { throw new Error('network called'); } },
  });
  assert.equal(result.dryRun, true);
  assert.equal(verifierCalls.length, 1);
  assert.deepEqual(store.actions, []);
  assert.equal((await readFile(join(fixture.releaseDir, 'release.json'))).length > 0, true);
});

test('publisher error redaction removes credentials, signing material, and internal endpoints', () => {
  const env = {
    KORDI_RELEASE_PUBLISHER_ACCESS_KEY: 'publisher-access-123',
    KORDI_RELEASE_PUBLISHER_SECRET_KEY: 'publisher-secret-456',
    TAURI_SIGNING_PRIVATE_KEY: 'private-updater-key',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'signature-password',
  };
  const redacted = redactPublisherText(
    'publisher-access-123 publisher-secret-456 private-updater-key signature-password http://minio.kordi-cloud.svc.cluster.local:9000/path',
    env,
  );
  for (const secret of Object.values(env)) assert.doesNotMatch(redacted, new RegExp(secret));
  assert.doesNotMatch(redacted, /minio|svc\.cluster\.local/i);
  assert.match(redacted, /REDACTED/);
});

test('public release verification accepts only the product origin', async () => {
  const requested = [];
  const publicHttp = createPublicHttpAdapter({
    fetchImpl: async (url, options) => {
      requested.push([url.toString(), options.method, options.headers.Range ?? null]);
      return {
        status: 200,
        headers: {},
        async arrayBuffer() {
          return Uint8Array.from([1, 2, 3]).buffer;
        },
      };
    },
  });

  await publicHttp.get('https://kordi.ai/updates/releases/version');
  await publicHttp.get('https://kordi.ai/updates/releases/version', { range: 'bytes=0-1' });
  await publicHttp.head('https://kordi.ai/updates/releases/version');
  await assert.rejects(
    publicHttp.get('https://example.com/updates/releases/version'),
    /must use https:\/\/kordi\.ai/i,
  );
  assert.deepEqual(requested, [
    ['https://kordi.ai/updates/releases/version', 'GET', null],
    ['https://kordi.ai/updates/releases/version', 'GET', 'bytes=0-1'],
    ['https://kordi.ai/updates/releases/version', 'HEAD', null],
  ]);
});

test('privacy scanning includes ignored build outputs and every mounted release file', () => {
  const args = releaseTreeScanArguments('/tmp/Kordi.app');
  assert.ok(args.includes('--no-ignore'));
  assert.ok(args.includes('--hidden'));
  assert.ok(args.includes('--text'));
  assert.equal(args.at(-1), '/tmp/Kordi.app');
});

test('release bundle scanning requires the canonical kordi.ai product origin', () => {
  assert.deepEqual(productOriginScanArguments('/tmp/Kordi.app'), [
    '--text',
    '--hidden',
    '--no-ignore',
    '--no-messages',
    '-l',
    '-F',
    'https://kordi.ai',
    '/tmp/Kordi.app',
  ]);
});

test('publisher CLI requires the exact release inputs and accepts pnpm separators', () => {
  assert.deepEqual(parsePublisherArguments([
    '--',
    '--release-dir', '/tmp/release',
    '--app-bundle', '/tmp/Kordi.app',
    '--version', VERSION,
    '--channel', 'acceptance',
    '--release-profile', 'adhoc-preview',
    '--expected-commit', '0123456789abcdef0123456789abcdef01234567',
    '--pub-date', PUB_DATE,
    '--dry-run',
  ]), {
    releaseDir: '/tmp/release',
    appBundle: '/tmp/Kordi.app',
    version: VERSION,
    channel: 'acceptance',
    releaseProfile: 'adhoc-preview',
    expectedCommit: '0123456789abcdef0123456789abcdef01234567',
    pubDate: PUB_DATE,
    dryRun: true,
  });
  assert.equal(parsePublisherArguments([]).releaseProfile, 'production');
  assert.throws(() => parsePublisherArguments(['--version']), /requires a value/i);
  assert.throws(() => parsePublisherArguments(['--unexpected']), /unknown publisher argument/i);
});

test('S3 adapter returns object validators and exposes only conditional puts for pointer mutations', async () => {
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (command.constructor.name === 'GetObjectCommand') {
        return {
          Body: { async transformToByteArray() { return Uint8Array.from([1, 2, 3]); } },
          ETag: '"etag-v1"',
          VersionId: 'version-v1',
        };
      }
      if (command.constructor.name === 'PutObjectCommand') return { ETag: '"etag-v2"', VersionId: 'version-v2' };
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
  const store = await createS3ReleaseStore({
    client,
    env: {
      KORDI_RELEASE_S3_ENDPOINT: 'http://127.0.0.1:9900',
      KORDI_RELEASE_S3_BUCKET: 'kordi-releases',
      KORDI_RELEASE_S3_REGION: 'us-east-1',
      KORDI_RELEASE_PUBLISHER_ACCESS_KEY: 'test-access',
      KORDI_RELEASE_PUBLISHER_SECRET_KEY: 'test-secret',
    },
  });
  assert.deepEqual(await store.getObject('desktop/releases/test'), {
    bytes: Buffer.from([1, 2, 3]),
    etag: '"etag-v1"',
    versionId: 'version-v1',
  });
  await store.putObject('desktop/releases/test', Buffer.from('immutable'), {
    immutable: true,
    contentType: 'application/octet-stream',
    cacheControl: 'immutable',
  });
  await store.putObject('desktop/channels/beta/latest.json', Buffer.from('{}'), {
    contentType: 'application/json',
    ifMatch: '"etag-v1"',
  });

  assert.equal(commands[1].constructor.name, 'PutObjectCommand');
  assert.equal(commands[1].input.Bucket, 'kordi-releases');
  assert.equal(commands[1].input.IfNoneMatch, '*');
  assert.equal(commands[2].input.IfNoneMatch, undefined);
  assert.equal(commands[2].input.IfMatch, '"etag-v1"');
  assert.equal(commands.length, 3);
  assert.equal(store.deleteObject, undefined);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { addIdentifierHashes } from './privacy-identifiers.mjs';
import { assertReleaseAddressesClean } from './lib/desktop-release-privacy-scan.mjs';
import { findPrivateIdentifiers, hashPrivateIdentifier } from './lib/private-identifiers.mjs';
import {
  inspectRepositoryPath,
  inspectText,
  formatFinding,
  scanComparison,
  scanRepository,
} from './repository-privacy-guard.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function git(repositoryRoot, ...args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
}

async function write(repositoryRoot, relativePath, contents) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
}

async function withRepository(run) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'kordi-privacy-guard-'));
  try {
    git(repositoryRoot, 'init', '-q', '-b', 'main');
    git(repositoryRoot, 'config', 'user.name', 'Example Contributor');
    git(repositoryRoot, 'config', 'user.email', 'contributor@example.com');
    await write(repositoryRoot, 'README.md', '# Safe repository\n');
    git(repositoryRoot, 'add', 'README.md');
    git(repositoryRoot, 'commit', '-q', '-m', 'initial safe source');
    await run(repositoryRoot);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}

test('path rules reject user exports, databases, auth stores, and support screenshots', () => {
  const unsafe = [
    'private/session-export-2026.jsonl',
    'cache/messages.sqlite-wal',
    'tmp/conversation-backup.zip',
    'support/chat-recording.m4a',
    'docs/customer-report.pdf',
    'app/desktop/auth.json',
    '.env.production',
    'deploy/dev/operator-github-allowlist.txt',
    'issue-assets/issue-123/processing-without-mention.png',
    'docs/screenshots/chat.png',
  ];
  for (const repositoryPath of unsafe) {
    assert.notEqual(inspectRepositoryPath(repositoryPath).length, 0, repositoryPath);
  }
});

test('path rules allow examples, source schemas, and synthetic visual baselines', () => {
  const safe = [
    '.env.example',
    'deploy/dev/operator-github-allowlist.example.txt',
    'shared/chat-sync/schemas/message.schema.json',
    'shared/blob-emoji/assets/blobwave.webp',
    'app/desktop/tests/visual/__screenshots__/transient-surfaces-dark.png',
  ];
  for (const repositoryPath of safe) {
    assert.deepEqual(inspectRepositoryPath(repositoryPath), [], repositoryPath);
  }
});

test('text rules reject credential material, personal metadata, and production hosts', () => {
  const personalEmail = ['private.user', 'gmail.com'].join('@');
  const privateKey = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const token = ['ghp', 'A'.repeat(24)].join('_');
  const unsafe = [
    personalEmail,
    '/Users/private-developer/project',
    privateKey,
    token,
  ];
  for (const contents of unsafe) {
    assert.notEqual(inspectText(contents).length, 0, contents.slice(0, 12));
  }
});

test('home-directory rules ignore lowercase URL paths but still catch macOS and Windows homes', () => {
  const developer = ['private', 'developer'].join('-');
  const macHome = ['', 'Users', developer, 'project'].join('/');
  const windowsHome = ['C:', 'Users', developer, 'project'].join('\\');

  assert.deepEqual(inspectText('https://app.fireworks.ai/settings/users/api-keys'), []);
  assert.deepEqual(inspectText(['', 'Users', 'example', 'project'].join('/')), []);
  assert.equal(inspectText(macHome).some((finding) => finding.rule === 'local-home-path'), true);
  for (const contents of [windowsHome, windowsHome.toLowerCase()]) {
    assert.equal(
      inspectText(contents).some((finding) => finding.rule === 'local-windows-home-path'),
      true,
      contents.slice(0, 3),
    );
  }
});

test('private organization terms can be supplied without committing them', () => {
  const privateTerm = ['private', 'identity'].join('-');
  const findings = inspectText(`owner=${privateTerm}`, { denylist: privateTerm });
  assert.equal(findings.some((finding) => finding.rule === 'private-denylist'), true);
});

test('paths containing private terms are redacted in CI output', () => {
  const privateTerm = ['private', 'identity'].join('-');
  const rendered = formatFinding({
    rule: 'private-denylist',
    path: `captures/${privateTerm}.txt`,
    origin: 'working-tree',
  }, { denylist: privateTerm });
  assert.doesNotMatch(rendered, new RegExp(privateTerm));
  assert.match(rendered, /redacted path sha256:/);
});

test('serialized chat transcript JSON is rejected even without an export filename', async () => {
  await withRepository(async (repositoryRoot) => {
    await write(repositoryRoot, 'fixtures/data.json', JSON.stringify({
      messages: [{ role: 'user', content: 'private conversation' }],
    }));
    const findings = scanRepository({ repositoryRoot });
    assert.equal(findings.some((finding) => finding.rule === 'transcript-shaped-json'), true);
  });
});

test('working-tree scan catches ignored-by-convention data before commit', async () => {
  await withRepository(async (repositoryRoot) => {
    await write(repositoryRoot, 'captures/message-export.jsonl', '{"message":"private"}\n');
    const findings = scanRepository({ repositoryRoot });
    assert.equal(findings.some((finding) => finding.rule === 'private-data-file'), true);
  });
});

test('comparison scan catches a harmful object even when a later commit deletes it', async () => {
  await withRepository(async (repositoryRoot) => {
    const base = git(repositoryRoot, 'rev-parse', 'HEAD').trim();
    await write(repositoryRoot, 'issue-assets/chat/processing.png', Buffer.from([0, 1, 2, 3]));
    git(repositoryRoot, 'add', 'issue-assets/chat/processing.png');
    git(repositoryRoot, 'commit', '-q', '-m', 'add temporary capture');
    git(repositoryRoot, 'rm', '-q', 'issue-assets/chat/processing.png');
    git(repositoryRoot, 'commit', '-q', '-m', 'remove temporary capture');

    const findings = scanComparison(repositoryRoot, `${base}...HEAD`);
    assert.equal(findings.some((finding) => finding.rule === 'unreviewed-user-capture'), true);
  });
});

test('comparison scan checks commit metadata without printing its contents', async () => {
  await withRepository(async (repositoryRoot) => {
    const base = git(repositoryRoot, 'rev-parse', 'HEAD').trim();
    await write(repositoryRoot, 'safe.txt', 'safe\n');
    git(repositoryRoot, 'add', 'safe.txt');
    const personalEmail = ['private.user', 'gmail.com'].join('@');
    git(repositoryRoot, 'commit', '-q', '-m', `temporary contact ${personalEmail}`);

    const findings = scanComparison(repositoryRoot, `${base}...HEAD`);
    assert.equal(findings.some((finding) => (
      finding.path === '(commit metadata)' && finding.rule === 'personal-mailbox'
    )), true);
  });
});

test('oversized text objects fail closed instead of skipping inspection', async () => {
  await withRepository(async (repositoryRoot) => {
    await write(repositoryRoot, 'oversized.txt', 'x'.repeat((20 * 1024 * 1024) + 1));
    const findings = scanRepository({ repositoryRoot });
    assert.equal(findings.some((finding) => finding.rule === 'oversized-text-object'), true);
  });
});

test('the current repository passes the privacy guard', () => {
  assert.deepEqual(scanRepository({ repositoryRoot: repoRoot }), []);
});

// Public upstream contacts are attribution data, not private Kordi account data.
test('license attribution exceptions are limited to reviewed contacts and paths', () => {
  const catalog = JSON.parse(readFileSync(path.join(repoRoot, 'legal/catalog.json'), 'utf8'));
  const contact = Object.values(catalog.documents).join('\n').match(/[A-Za-z0-9._%+-]+@(?:gmail|outlook|hotmail|icloud|qq|163)\.com/i)[0];
  const options = { repositoryPath: 'legal/distribution/THIRD-PARTY-NOTICES.txt' };
  assert.deepEqual(inspectText(contact, options), []);
  assert.ok(inspectText(contact).some((finding) => finding.rule === 'personal-mailbox'));
  assert.ok(inspectText('synthetic-not-an-upstream-author-999@gmail.com', options).some((finding) => finding.rule === 'personal-mailbox'));
  assert.ok(inspectText(contact, { ...options, denylist: [contact] }).some((finding) => finding.rule === 'private-denylist'));
  assert.ok(inspectText(contact + '\n-----BEGIN PRIVATE KEY-----', options).some((finding) => finding.rule === 'private-key'));
});

// Infrastructure values below are assembled at runtime so that no address, project, or host
// literal appears in this file, even a synthetic one.
const ip = (...octets) => octets.join('.');
const rulesFor = (contents) => inspectText(contents).map((finding) => finding.rule);

test('public IPv4 addresses are rejected outside reserved, documentation, and service ranges', () => {
  const publicAddress = ip(11, 22, 33, 44);
  for (const contents of [
    `origin ${publicAddress}`,
    `"host": "${publicAddress}"`,
    `ssh root@${publicAddress}`,
    `the host at ${publicAddress} and ${publicAddress}`,
    `Value: ${publicAddress}`,
    `${publicAddress}:8080`,
    `${ip(11, 22, 33, 44)} ${ip(11, 22, 33, 45)} ${ip(11, 22, 33, 46)}`,
  ]) {
    assert.ok(rulesFor(contents).includes('public-ip-address'), contents.length.toString());
  }
  for (const address of [
    ip(127, 0, 0, 1), ip(10, 4, 5, 6), ip(172, 20, 1, 1), ip(192, 168, 1, 20), ip(100, 64, 0, 1),
    ip(169, 254, 169, 254), ip(0, 0, 0, 0), ip(192, 0, 2, 10), ip(198, 51, 100, 7), ip(203, 0, 113, 7),
    ip(224, 0, 0, 1), ip(255, 255, 255, 255), ip(8, 8, 8, 8), ip(1, 1, 1, 1), ip(35, 191, 0, 0),
  ]) {
    assert.deepEqual(rulesFor(`address ${address}`), [], address);
  }
});

test('IPv4-shaped version strings and vector path data are not addresses', () => {
  assert.deepEqual(rulesFor('macOS 13.0.0.0 and build 1.2.03.4 and 300.1.1.1'), []);
  assert.deepEqual(rulesFor('d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 1.08.58 1.23.82.72 1.21 1.87"'), []);
  assert.deepEqual(rulesFor('-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07'), []);
});

test('public IPv6 addresses are rejected outside documentation and resolver ranges', () => {
  const publicAddress = ['2a00', '1450', '4001', '82a', '', '200e'].join(':');
  assert.ok(rulesFor(`AAAA ${publicAddress}`).includes('public-ip-address'));
  for (const contents of [
    ['2001', 'db8', '', '1'].join(':'), '::1', ['fe80', '', '1'].join(':'), ['2606', '4700', '4700', '', '1111'].join(':'),
    ['2002', '7f00', '1', ''].join(':'), ['3fff', '', '1'].join(':'), 'at 20:30:45', ['2026', '11', '04'].join(':'), ['2000', '', ''].join(':') + '/3',
  ]) {
    assert.deepEqual(rulesFor(contents), [], contents);
  }
});

test('IP-embedding DNS names and cloud reverse DNS names are rejected', () => {
  const embedding = ['legacy-api', ip(11, 22, 33, 44), 'sslip', 'io'].join('.');
  const dashed = [`app-${[11, 22, 33, 44].join('-')}`, 'nip', 'io'].join('.');
  assert.ok(rulesFor(`https://${embedding}/v1`).includes('ip-embedding-hostname'));
  assert.ok(rulesFor(['', 'x', [11, 22, 33, 44].join('-'), 'sslip', 'io'].join('.')).includes('ip-embedding-hostname'));
  assert.ok(rulesFor(dashed).includes('ip-embedding-hostname'));
  assert.deepEqual(rulesFor([ip(127, 0, 0, 1), 'nip', 'io'].join('.')), []);
  const reverse = ['44', '33', '22', '11', 'bc', 'googleusercontent', 'com'].join('.');
  assert.ok(rulesFor(reverse).includes('cloud-reverse-dns'));
});

test('Google Cloud project, zone, instance, and service-account identifiers are rejected', () => {
  const project = ['acme', 'prod', '4821'].join('-');
  const unsafe = {
    'gcp-project-identifier': [['project', '1a2b3c4d', '5e6f', '7a8b'].join('-'), `projects/${'4'.repeat(12)}/secrets/x`],
    'gcloud-project-flag': [
      `gcloud compute ssh vm --project=${project}`,
      `gcloud compute ssh vm \\\n  --project "${project}" \\\n  --zone "<ZONE>"`,
      `gcloud config set project ${project}`,
    ],
    'gcloud-zone-flag': [`gcloud compute ssh vm --zone=${['us', 'central1', 'b'].join('-')}`],
    'gcp-service-account': [
      `deployer@${project}.iam.gserviceaccount.com`,
      `${'1'.repeat(12)}-compute@developer.gserviceaccount.com`,
    ],
    'gcp-internal-hostname': [['vm', 'zone-1', 'c', project, 'internal'].join('.')],
    'gcp-instance-id': [`compute.${'7'.repeat(19)}`],
  };
  for (const [rule, samples] of Object.entries(unsafe)) {
    for (const contents of samples) {
      assert.ok(rulesFor(contents).includes(rule), `${rule}: ${contents.length}`);
    }
  }
  for (const contents of [
    'gcloud compute ssh vm --project "$PROJECT" --zone "${ZONE}"',
    'gcloud compute ssh vm --project=<PRODUCT_GCP_PROJECT> --zone=<ZONE>',
    'gcloud compute ssh vm --project example-project --zone example-zone',
    'gcloud compute ssh vm --project test-project-123456 --zone test-zone-a',
    'playwright test --project chromium',
    'bridges sync --project proj_xxxxxxxx',
    'push@project.iam.gserviceaccount.com attacker@other.iam.gserviceaccount.com',
    'https://aiplatform.googleapis.com/v1/projects/123456/locations/x',
  ]) {
    assert.deepEqual(rulesFor(contents), [], contents);
  }
});

test('Linux home paths are rejected unless they are placeholders', () => {
  const home = ['', 'home', 'jdoe', 'backups', 'db.dump'].join('/');
  assert.ok(rulesFor(home).includes('linux-home-path'));
  assert.ok(rulesFor(`cd ${['', 'home', 'jdoe'].join('/')}`).includes('linux-home-path'));
  for (const contents of [
    '/home/runner/work', '/home/user/.config', '/home/example-user/x', '/home/tester/.codex',
    '/home/@KORDI_CLOUD_DEPLOY_USER@/deploy', 'https://example.com/home/jdoe/', '../home/jdoe/x',
    'crates/home/home-0.5.12.crate', '/home/three.md', '/home/*',
  ]) {
    assert.deepEqual(rulesFor(contents), [], contents);
  }
});

test('hashed private identifiers match whole dotted label runs without publishing values', () => {
  const host = ['private', 'host', '7'].join('-');
  const address = ip(11, 22, 33, 44);
  const hashes = new Set([hashPrivateIdentifier(host), hashPrivateIdentifier(address)]);
  const inspect = (contents) => inspectText(contents, { identifierHashes: hashes }).map((finding) => finding.rule);

  for (const contents of [
    `gcloud compute ssh ${host}`,
    `${host.toUpperCase()}.example.com`,
    `https://api.${address}.example.io`,
    `${['', 'srv', host, 'data'].join('/')}`,
  ]) {
    assert.ok(inspect(contents).includes('private-identifier'), contents.length.toString());
  }
  for (const contents of [`${host}-backup`, `pre-${host}`, `${host}0`]) {
    assert.equal(inspect(contents).includes('private-identifier'), false, contents.length.toString());
  }
  const found = findPrivateIdentifiers(`ssh ${host}`, hashes);
  assert.deepEqual(found, [hashPrivateIdentifier(host)]);
  assert.equal(found.join('').includes(host), false);
});

test('the committed identifier list holds only sorted unique SHA-256 hashes', () => {
  const hashes = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/lib/private-identifier-hashes.json'), 'utf8'));
  assert.ok(Array.isArray(hashes) && hashes.length > 0);
  assert.ok(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  assert.deepEqual(hashes, [...new Set(hashes)].sort());
});

test('adding identifiers stores normalized hashes only', () => {
  const value = ['Private', 'Host', '9'].join('-');
  const { hashes, added } = addIdentifierHashes(['f'.repeat(64)], [` ${value} `, value.toLowerCase(), '']);
  assert.equal(added, 1);
  assert.deepEqual(hashes, [hashPrivateIdentifier(value.toLowerCase()), 'f'.repeat(64)].sort());
  assert.equal(JSON.stringify(hashes).toLowerCase().includes(value.toLowerCase()), false);
});

test('release bundle address scan fails on hashed former addresses without naming them', () => {
  const address = ip(11, 22, 33, 44);
  const hashes = new Set([hashPrivateIdentifier(address)]);
  const run = (stdout, status = 0) => () => ({ status, stdout, stderr: '' });
  assert.throws(
    () => assertReleaseAddressesClean(run(`Kordi.app/Contents/MacOS/Kordi:12:${address}\n`), '/tmp/Kordi.app', hashes),
    (error) => !error.message.includes(address),
  );
  assertReleaseAddressesClean(run(`Kordi.app/Contents/MacOS/Kordi:12:${ip(1, 2, 3, 4)}\n`), '/tmp/Kordi.app', hashes);
  assertReleaseAddressesClean(run('', 1), '/tmp/Kordi.app', hashes);
  assert.throws(() => assertReleaseAddressesClean(run('', 2), '/tmp/Kordi.app', hashes), /could not inspect/);
});

test('GitHub text scan reports locations and rules without the matched text', async () => {
  const { scanGitHubText } = await import('./scan-github-text.mjs');
  const home = ['', 'home', 'jdoe', 'backups'].join('/');
  const pages = {
    '/issues?': [
      { number: 7, title: 'Safe title', body: `Backup at ${home}` },
      { number: 8, title: 'Clean', body: 'Nothing private', pull_request: {} },
    ],
    '/issues/comments': [{ id: 11, issue_url: 'https://api.github.com/repos/o/r/issues/8', body: `see ${home}` }],
    '/pulls/comments': [],
    '/repos/o/r/comments': [],
    '/releases': [{ id: 3, name: 'v1', body: 'notes' }],
  };
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const key = Object.keys(pages).find((candidate) => url.includes(candidate));
    return { ok: true, status: 200, headers: new Headers(), json: async () => pages[key] ?? [] };
  };
  const { scanned, findings } = await scanGitHubText({ repository: 'o/r', token: 't', fetchImpl });
  assert.equal(scanned, 4);
  assert.deepEqual(findings, [
    { location: 'issue #7 title or body', rules: ['linux-home-path'] },
    { location: 'comment 11 on #8', rules: ['linux-home-path'] },
  ]);
  assert.equal(JSON.stringify(findings).includes('jdoe'), false);
  assert.ok(requested.every((url) => url.includes('per_page=100')));
});

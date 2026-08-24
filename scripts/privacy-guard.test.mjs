import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
    'gcloud compute ssh kordi-product-app-42',
    privateKey,
    token,
  ];
  for (const contents of unsafe) {
    assert.notEqual(inspectText(contents).length, 0, contents.slice(0, 12));
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

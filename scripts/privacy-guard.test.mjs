import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repoRoot = new URL('..', import.meta.url);

function git(...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function trackedFiles() {
  return git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
    .split('\0')
    .filter(Boolean);
}

const forbiddenDataFile = /(?:^|\/)(?:session|account|message|conversation)-export[^/]*$|\.(?:db|sqlite|sqlite3|jsonl|ndjson|dump|bak|pem|key|p12|pfx|jks|keystore)$/i;
const privateKeyMarker = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const credentialMarker = /(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}/;
const knownPrivateIdentity = /Jiaxin(?: Pei)?|Shenzhe(?: Zhu)?|Shu[ _-]?Yang|Shuyang|shuyhere|C[ _-]?UFishAI|UFishAI|贾\s*欣/i;
const privateInfrastructure = /hai-gcp-representation|kordi-product-app-01|\btakotako\b/i;
const personalMailbox = /[A-Za-z0-9._%+-]+@(?:gmail|outlook|hotmail|icloud|qq|163)\.com/i;
const localUserPath = /\/Users\/(?!example(?:[\/\s<"'`]|$)|alice(?:[\/\s<"'`]|$)|owner(?:[\/\s<"'`]|$)|you(?:[\/\s<"'`]|$)|kordi-ci(?:[\/\s<"'`]|$)|\.\.\.(?:[\/\s<"'`]|$)|\*(?:[\/\s<"'`]|$)|\$\{RUNNER_ACCOUNT\}(?:[\/\s<"'`]|$))[^/\s<"'`]+/i;

test('tracked repository contains no local data exports or database snapshots', () => {
  const unsafe = trackedFiles().filter((path) => forbiddenDataFile.test(path));
  assert.deepEqual(unsafe, []);
});

test('tracked text contains no known production identities or private keys', async () => {
  const findings = [];
  for (const path of trackedFiles()) {
    if (path === 'scripts/privacy-guard.test.mjs') {
      continue;
    }
    let contents;
    try {
      contents = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    } catch {
      continue;
    }
    if (
      personalMailbox.test(contents)
      || localUserPath.test(contents)
      || privateKeyMarker.test(contents)
      || credentialMarker.test(contents)
      || knownPrivateIdentity.test(contents)
      || privateInfrastructure.test(contents)
    ) {
      findings.push(path);
    }
  }
  assert.deepEqual(findings, []);
});

test('operator identities and support mailboxes stay outside the repository', async () => {
  const files = new Set(trackedFiles());
  assert.equal(files.has('deploy/dev/operator-github-allowlist.txt'), false);
  assert.equal(files.has('deploy/dev/operator-github-allowlist.example.txt'), true);

  const deployment = await readFile(
    new URL('../bridges/cloud-server/deploy/k3s/manifests/cloud-server-deployment.yaml', import.meta.url),
    'utf8',
  );
  for (const key of ['owner-email', 'inbox', 'username', 'from']) {
    assert.match(deployment, new RegExp(`key: ${key}`));
  }
  assert.doesNotMatch(deployment, /value:\s*["']?[^\n]*@[^\n]*(?:gmail|outlook|hotmail|icloud|qq|163)\.com/i);
});

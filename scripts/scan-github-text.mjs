#!/usr/bin/env node
// Applies the repository privacy rules to public GitHub text: issue and pull request titles
// and bodies, issue and pull request comments, review comments, commit comments, and release
// notes. It only reads. Output names the location and rule, never the matched text.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/scan-github-text.mjs

import { appendFileSync } from 'node:fs';

import { inspectText } from './repository-privacy-guard.mjs';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';

async function* paginate(path, { token, fetchImpl = fetch } = {}) {
  let url = `${API}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (url) {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GitHub API request failed with status ${response.status}`);
    for (const item of await response.json()) yield item;
    url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
  }
}

function issueNumber(url) {
  return /\/(?:issues|pulls)\/(\d+)(?:$|[/?#])/.exec(url ?? '')?.[1] ?? '?';
}

export const TEXT_SOURCES = [
  {
    path: (repository) => `/repos/${repository}/issues?state=all`,
    texts: (item) => [`${item.title ?? ''}\n${item.body ?? ''}`],
    location: (item) => `${item.pull_request ? 'pull request' : 'issue'} #${item.number} title or body`,
  },
  {
    path: (repository) => `/repos/${repository}/issues/comments`,
    texts: (item) => [item.body ?? ''],
    location: (item) => `comment ${item.id} on #${issueNumber(item.issue_url)}`,
  },
  {
    path: (repository) => `/repos/${repository}/pulls/comments`,
    texts: (item) => [item.body ?? ''],
    location: (item) => `review comment ${item.id} on #${issueNumber(item.pull_request_url)}`,
  },
  {
    path: (repository) => `/repos/${repository}/comments`,
    texts: (item) => [item.body ?? ''],
    location: (item) => `commit comment ${item.id}`,
  },
  {
    path: (repository) => `/repos/${repository}/releases`,
    texts: (item) => [`${item.name ?? ''}\n${item.body ?? ''}`],
    location: (item) => `release ${item.id} notes`,
  },
];

export async function scanGitHubText({ repository, token, denylist = '', fetchImpl } = {}) {
  const findings = [];
  let scanned = 0;
  for (const source of TEXT_SOURCES) {
    for await (const item of paginate(source.path(repository), { token, fetchImpl })) {
      scanned += 1;
      const rules = new Set();
      for (const text of source.texts(item)) {
        for (const finding of inspectText(text, { denylist })) rules.add(finding.rule);
      }
      if (rules.size > 0) findings.push({ location: source.location(item), rules: [...rules].sort() });
    }
  }
  return { scanned, findings };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) {
    console.error('[kordi] GITHUB_REPOSITORY and GITHUB_TOKEN are required.');
    process.exitCode = 2;
    return;
  }
  const denylist = process.env.KORDI_PRIVACY_DENYLIST ?? '';
  if (!denylist.trim()) {
    console.log('[kordi] KORDI_PRIVACY_DENYLIST is unavailable; the committed hashed identifiers and shape rules still apply.');
  }
  const { scanned, findings } = await scanGitHubText({ repository, token, denylist });
  const lines = findings.map(({ location, rules }) => `- ${location}: ${rules.join(', ')}`);
  const summary = findings.length === 0
    ? `Privacy scan of GitHub text passed: ${scanned} items are clean.`
    : `Privacy scan of GitHub text found ${findings.length} of ${scanned} items with private or infrastructure data. Only locations and rule identifiers are shown.`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n${lines.join('\n')}\n`);
  }
  if (findings.length === 0) {
    console.log(`[kordi] ${summary}`);
    return;
  }
  console.error(`[kordi] ${summary}`);
  for (const line of lines) console.error(`  ${line}`);
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

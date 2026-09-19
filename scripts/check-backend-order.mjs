#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function deploymentOrder(current, candidate, comparison) {
  if (!/^[0-9a-f]{40}$/.test(candidate) || (current !== 'none' && !/^[0-9a-f]{40}$/.test(current))) {
    throw new Error('Deployment revisions must be full commit identifiers');
  }
  if (current === 'none' || current === candidate) return 'deploy';
  if (comparison?.status === 'ahead' && comparison.merge_base_commit?.sha === current) return 'deploy';
  if (comparison?.status === 'behind' && comparison.merge_base_commit?.sha === candidate) return 'superseded';
  throw new Error('The candidate and deployed revision do not have a verified mainline relationship');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [current, candidate] = process.argv.slice(2);
    if (!/^(none|[0-9a-f]{40})$/.test(current ?? '') || !/^[0-9a-f]{40}$/.test(candidate ?? '')) throw new Error('Invalid deployment revision');
    const repo = process.env.GITHUB_REPOSITORY;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('GITHUB_REPOSITORY is required');
    const comparison = current === 'none' || current === candidate ? null : JSON.parse(execFileSync('gh',
      ['api', `repos/${repo}/compare/${current}...${candidate}`], { encoding: 'utf8' }));
    const result = deploymentOrder(current, candidate, comparison);
    console.log(result === 'deploy' ? 'Candidate advances the deployed backend revision' : 'A newer backend revision is already deployed');
    process.exitCode = result === 'superseded' ? 3 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

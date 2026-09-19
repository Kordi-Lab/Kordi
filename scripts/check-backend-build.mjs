#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateBuild(run, artifacts, repo) {
  if (run.path !== '.github/workflows/backend-delivery.yml'
    || !['workflow_run', 'workflow_dispatch'].includes(run.event)
    || run.head_branch !== 'main' || run.conclusion !== 'success' || run.status !== 'completed'
    || run.repository?.full_name !== repo || run.head_repository?.full_name !== repo
    || run.head_repository?.fork !== false) {
    throw new Error('Production requires a successful trusted main backend-delivery run');
  }
  const started = Date.parse(run.run_started_at);
  if (!Number.isFinite(started)) throw new Error('Build attempt timestamp is missing');
  const select = (name) => {
    const matches = artifacts.filter((artifact) => artifact.name === name && !artifact.expired
      && Date.parse(artifact.created_at) >= started);
    if (matches.length !== 1) throw new Error(`Expected one current-attempt artifact: ${name}`);
    return matches[0].id;
  };
  return { bundle: select('backend-bundle'), development: select('development-deployment-result') };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const runId = process.argv[2];
    const repo = process.env.GITHUB_REPOSITORY;
    if (!/^[1-9][0-9]*$/.test(runId ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
      throw new Error('Pass a backend build run ID and GITHUB_REPOSITORY');
    }
    const api = (path) => JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${path}`], { encoding: 'utf8' }));
    const ids = validateBuild(api(`actions/runs/${runId}`), api(`actions/runs/${runId}/artifacts?per_page=100`).artifacts, repo);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `bundle=${ids.bundle}\ndevelopment=${ids.development}\n`);
    console.log(`Verified backend build ${runId} and its development deployment evidence`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

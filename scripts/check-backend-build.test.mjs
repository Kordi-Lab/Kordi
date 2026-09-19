import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBuild } from './check-backend-build.mjs';

const repo = 'example/kordi';
const run = { path: '.github/workflows/backend-delivery.yml', event: 'workflow_run', head_branch: 'main',
  status: 'completed', conclusion: 'success', repository: { full_name: repo },
  head_repository: { full_name: repo, fork: false }, run_started_at: '2026-09-19T10:00:00Z' };
const artifacts = ['backend-bundle', 'development-deployment-result'].map((name, index) => ({
  name, id: index + 1, expired: false, created_at: '2026-09-19T10:01:00Z',
}));

test('promotion selects exact immutable artifact IDs from a successful trusted run', () => {
  assert.deepEqual(validateBuild(run, artifacts, repo), { bundle: 1, development: 2 });
});
test('promotion rejects forks, wrong workflows, failed runs, and stale or missing artifacts', () => {
  for (const override of [{ conclusion: 'failure' }, { head_branch: 'feature' },
    { path: '.github/workflows/other.yml' }, { head_repository: { full_name: 'fork/repo', fork: true } }]) {
    assert.throws(() => validateBuild({ ...run, ...override }, artifacts, repo));
  }
  assert.throws(() => validateBuild(run, artifacts.slice(0, 1), repo));
  assert.throws(() => validateBuild(run, artifacts.map((a) => ({ ...a, expired: true })), repo));
  assert.throws(() => validateBuild({ ...run, run_started_at: '2026-09-19T11:00:00Z' }, artifacts, repo));
  assert.throws(() => validateBuild(run, [...artifacts, artifacts[0]], repo));
});

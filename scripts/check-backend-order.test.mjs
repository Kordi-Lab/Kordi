import assert from 'node:assert/strict';
import test from 'node:test';
import { deploymentOrder } from './check-backend-order.mjs';
const older = 'a'.repeat(40);
const newer = 'b'.repeat(40);
test('initial deployment and same-revision retry are permitted', () => {
  assert.equal(deploymentOrder('none', newer), 'deploy');
  assert.equal(deploymentOrder(newer, newer), 'deploy');
});
test('a tested descendant can deploy regardless of unrelated new main commits', () => {
  assert.equal(deploymentOrder(older, newer, { status: 'ahead', merge_base_commit: { sha: older } }), 'deploy');
});
test('an older late-finishing build cannot overwrite a newer deployed backend', () => {
  assert.equal(deploymentOrder(newer, older, { status: 'behind', merge_base_commit: { sha: older } }), 'superseded');
});
test('divergent, malformed, and missing comparison evidence fail closed', () => {
  for (const comparison of [null, { status: 'diverged' }, { status: 'ahead', merge_base_commit: { sha: newer } }]) {
    assert.throws(() => deploymentOrder(older, newer, comparison));
  }
  assert.throws(() => deploymentOrder('invalid', newer));
});

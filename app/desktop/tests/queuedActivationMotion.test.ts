import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planActivationMotion, type ActivationRow, type ActivationSnapshot } from '../src/features/chat/queuedActivationMotion';

const row = (id: string, extra: Partial<ActivationRow> = {}): ActivationRow => ({ id, aliases: [id], queued: false, processing: false, ...extra });
const snapshot = (queued: string[], rows: string[], sessionKey = 's'): ActivationSnapshot => ({ sessionKey, queuedIds: new Set(queued), rowIds: new Set(rows) });

test('a request that stops being a queued bubble animates once', () => {
  const rows = [row('old'), row('req')];
  assert.deepEqual(planActivationMotion(snapshot(['req'], ['old', 'req']), 's', rows, new Set()), ['req']);
  assert.deepEqual(planActivationMotion(snapshot(['req'], ['old', 'req']), 's', rows, new Set(['req'])), []);
  assert.deepEqual(planActivationMotion(snapshot([], ['old', 'req']), 's', rows, new Set()), []);
});

test('a row still drawn as queued, or matched by alias, is handled correctly', () => {
  assert.deepEqual(planActivationMotion(snapshot(['req'], ['req']), 's', [row('req', { queued: true })], new Set()), []);
  assert.deepEqual(planActivationMotion(snapshot(['local'], ['x']), 's', [row('server', { aliases: ['server', 'local'] })], new Set()), ['server']);
});

test('a processing row animates when it appears, not on later renders', () => {
  const processing = row('resp', { processing: true });
  assert.deepEqual(planActivationMotion(snapshot([], ['req']), 's', [row('req'), processing], new Set()), ['resp']);
  assert.deepEqual(planActivationMotion(snapshot([], ['req', 'resp']), 's', [row('req'), processing], new Set()), []);
});

test('nothing animates on the first render or after a session switch', () => {
  const rows = [row('req'), row('resp', { processing: true })];
  assert.deepEqual(planActivationMotion(null, 's', rows, new Set()), []);
  assert.deepEqual(planActivationMotion(snapshot(['req'], []), 'other', rows, new Set()), []);
});

test('advanceActivation tracks active rows, is stable when idle, and clears on finish', async () => {
  const { advanceActivation, finishActivation, initialActivationState } = await import('../src/features/chat/queuedActivationMotion');
  const queuedRows = [row('req', { queued: true })];
  const first = advanceActivation(initialActivationState, 's', queuedRows, new Set(['req']));
  assert.equal(advanceActivation(first, 's', queuedRows, new Set(['req'])), first, 'unchanged render returns the same state');
  const sentRows = [row('req'), row('resp', { processing: true })];
  const active = advanceActivation(first, 's', sentRows, new Set());
  assert.deepEqual([...active.activeIds].sort(), ['req', 'resp']);
  assert.equal(advanceActivation(active, 's', sentRows, new Set()), active);
  const done = finishActivation(finishActivation(active, 'req'), 'resp');
  assert.equal(done.activeIds.size, 0);
  assert.equal(advanceActivation(done, 's', sentRows, new Set()), done, 'finished rows never animate again');
  assert.equal(advanceActivation(active, 'other', sentRows, new Set()).activeIds.size, 0);
});

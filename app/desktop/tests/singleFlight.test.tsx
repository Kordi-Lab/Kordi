import assert from 'node:assert/strict';
import test from 'node:test';

import { createSingleFlightState, requestSingleFlightRun } from '../src/lib/singleFlight';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('requestSingleFlightRun prevents overlapping async work and runs one trailing request', async () => {
  const flight = createSingleFlightState();
  const firstBlocker = deferred();
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;

  const firstRun = requestSingleFlightRun(flight, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push('first:start');
    await firstBlocker.promise;
    order.push('first:end');
    active -= 1;
  });

  assert.ok(firstRun, 'initial request should own the runner');

  const queuedRun = requestSingleFlightRun(flight, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push('second');
    active -= 1;
  });

  assert.equal(queuedRun, null, 'overlapping request should be queued instead of started');
  assert.deepEqual(order, ['first:start']);

  firstBlocker.resolve();
  await firstRun;

  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
  assert.equal(maxActive, 1, 'single-flight work must never overlap');
  assert.equal(flight.running, false);
});

test('requestSingleFlightRun keeps only the latest trailing request while work is active', async () => {
  const flight = createSingleFlightState();
  const firstBlocker = deferred();
  const order: string[] = [];

  const firstRun = requestSingleFlightRun(flight, async () => {
    order.push('first');
    await firstBlocker.promise;
  });

  assert.ok(firstRun);
  assert.equal(
    requestSingleFlightRun(flight, async () => {
      order.push('stale-second');
    }),
    null,
  );
  assert.equal(
    requestSingleFlightRun(flight, async () => {
      order.push('latest-third');
    }),
    null,
  );

  firstBlocker.resolve();
  await firstRun;

  assert.deepEqual(order, ['first', 'latest-third']);
});

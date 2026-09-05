import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAgentTurnCoordinator } from '../src/features/cloud/cloudAgentTurnCoordinator';
import { cloudGroupAgentRequestRuntimeSessionId } from '../src/features/cloud/cloudAgentRuntime';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test('mentions of the same group agent use independent request runtimes', async () => {
  const coordinator = new CloudAgentTurnCoordinator('acct_me');
  const gate = deferred();
  const bothStarted = deferred();
  const started: string[] = [];
  for (const requestId of ['request:1', 'request:2']) {
    const runtimeSessionId = cloudGroupAgentRequestRuntimeSessionId('runtime:group:agent', requestId);
    const job = {
      runtimeSessionId,
      requestId,
      run: async () => {
        started.push(requestId);
        if (started.length === 2) bothStarted.resolve();
        await gate.promise;
      },
    };
    assert.deepEqual(coordinator.enqueue(job), { accepted: true, queued: false });
    assert.equal(coordinator.enqueue(job).accepted, false);
  }
  await bothStarted.promise;
  assert.deepEqual(started, ['request:1', 'request:2']);
  gate.resolve();
  await coordinator.waitForIdle();
});

test('same runtime jobs execute in FIFO order without overlapping', async () => {
  const coordinator = new CloudAgentTurnCoordinator('acct_me');
  const firstGate = deferred();
  const firstStarted = deferred();
  const events: string[] = [];

  const first = coordinator.enqueue({
    runtimeSessionId: 'runtime:a',
    requestId: 'request:1',
    run: async () => {
      events.push('first:start');
      firstStarted.resolve();
      await firstGate.promise;
      events.push('first:end');
    },
  });
  const second = coordinator.enqueue({
    runtimeSessionId: 'runtime:a',
    requestId: 'request:2',
    run: async () => {
      events.push('second:start');
      events.push('second:end');
    },
  });

  await firstStarted.promise;
  assert.deepEqual(first, { accepted: true, queued: false });
  assert.deepEqual(second, { accepted: true, queued: true });
  assert.deepEqual(events, ['first:start']);

  firstGate.resolve();
  await coordinator.waitForIdle('runtime:a');
  assert.deepEqual(events, [
    'first:start',
    'first:end',
    'second:start',
    'second:end',
  ]);
});

test('different runtime jobs may execute concurrently', async () => {
  const coordinator = new CloudAgentTurnCoordinator('acct_me');
  const gate = deferred();
  const bothStarted = deferred();
  const started: string[] = [];

  coordinator.enqueue({
    runtimeSessionId: 'runtime:a',
    requestId: 'request:1',
    run: async () => {
      started.push('a');
      if (started.length === 2) bothStarted.resolve();
      await gate.promise;
    },
  });
  coordinator.enqueue({
    runtimeSessionId: 'runtime:b',
    requestId: 'request:2',
    run: async () => {
      started.push('b');
      if (started.length === 2) bothStarted.resolve();
      await gate.promise;
    },
  });

  await bothStarted.promise;
  assert.deepEqual(started.sort(), ['a', 'b']);
  gate.resolve();
  await coordinator.waitForIdle();
});

test('the original request id is admitted only once per runtime', async () => {
  const coordinator = new CloudAgentTurnCoordinator('acct_me');
  let runs = 0;
  const job = {
    runtimeSessionId: 'runtime:a',
    requestId: 'request:1',
    run: async () => {
      runs += 1;
    },
  };

  assert.equal(coordinator.enqueue(job).accepted, true);
  assert.equal(coordinator.enqueue(job).accepted, false);
  await coordinator.waitForIdle();
  assert.equal(runs, 1);
});

test('a failed turn is reported and the next queued turn still runs', async () => {
  const coordinator = new CloudAgentTurnCoordinator('acct_me');
  const events: string[] = [];

  coordinator.enqueue({
    runtimeSessionId: 'runtime:a',
    requestId: 'request:1',
    run: async () => {
      events.push('first:start');
      throw new Error('runtime admission failed');
    },
    onError: async () => {
      events.push('first:failed');
    },
  });
  coordinator.enqueue({
    runtimeSessionId: 'runtime:a',
    requestId: 'request:2',
    run: async () => {
      events.push('second:start');
    },
  });

  await coordinator.waitForIdle('runtime:a');
  assert.deepEqual(events, [
    'first:start',
    'first:failed',
    'second:start',
  ]);
});

test('account changes discard queued jobs from the previous context', async () => {
  const coordinator = new CloudAgentTurnCoordinator('acct_old');
  const gate = deferred();
  const firstStarted = deferred();
  const firstFinished = deferred();
  const events: string[] = [];

  coordinator.enqueue({
    runtimeSessionId: 'runtime:a',
    requestId: 'request:1',
    run: async () => {
      events.push('first:start');
      firstStarted.resolve();
      await gate.promise;
      events.push('first:end');
      firstFinished.resolve();
    },
  });
  coordinator.enqueue({
    runtimeSessionId: 'runtime:a',
    requestId: 'request:2',
    run: async () => {
      events.push('stale:start');
    },
  });

  await firstStarted.promise;
  coordinator.changeAccount('acct_new');
  gate.resolve();
  await firstFinished.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['first:start', 'first:end']);
});

test('account changes abort active work from the previous context', async () => {
  const coordinator = new CloudAgentTurnCoordinator('acct_old');
  const started = deferred();
  const aborted = deferred();
  let observedAbort = false;

  coordinator.enqueue({
    runtimeSessionId: 'runtime:a',
    requestId: 'request:active',
    run: async (signal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          observedAbort = signal.aborted;
          resolve();
        }, { once: true });
      });
      aborted.resolve();
    },
  });

  await started.promise;
  coordinator.changeAccount('acct_new');
  await aborted.promise;
  assert.equal(observedAbort, true);
});

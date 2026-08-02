import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginChatPerformanceSpan,
  chatPerformancePayloadBytes,
  clearChatPerformanceRecords,
  completeSessionClickToFirstMessage,
  finishChatPerformanceSpan,
  readChatPerformanceRecords,
  startSessionClickToFirstMessage,
} from '../src/features/performance/chatPerformance';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';

declare global {
  // Test the same explicit runtime switch available to native diagnostics.
  var __KORDI_PERF_DIAGNOSTICS__: boolean | undefined;
}

test.beforeEach(() => {
  delete globalThis.__KORDI_PERF_DIAGNOSTICS__;
  clearChatPerformanceRecords();
});

test.after(() => {
  delete globalThis.__KORDI_PERF_DIAGNOSTICS__;
});

function withoutPerformanceDebug(run: () => void) {
  const originalDebug = globalThis.console.debug;
  globalThis.console.debug = () => {};
  try {
    run();
  } finally {
    globalThis.console.debug = originalDebug;
  }
}

test('performance spans stay disabled outside Vite development without an explicit flag', () => {
  const span = beginChatPerformanceSpan('canonical-page-ipc');
  assert.equal(span, null);
  assert.deepEqual(readChatPerformanceRecords(), []);
});

test('performance spans expose only fixed counts, result classes, and payload bytes', () => {
  globalThis.__KORDI_PERF_DIAGNOSTICS__ = true;
  withoutPerformanceDebug(() => {
    const span = beginChatPerformanceSpan('cloud-message-index');
    assert.ok(span);
    finishChatPerformanceSpan(span, () => ({
      messageCount: 20_000,
      rowCount: 1_000,
      payloadBytes: chatPerformancePayloadBytes('\u4F60\u597D'),
      resultClass: 'success',
      accountId: 'acct_secret',
    } as never));
  });

  const [record] = readChatPerformanceRecords();
  assert.equal(record?.name, 'cloud-message-index');
  assert.equal(record?.metrics.messageCount, 20_000);
  assert.equal(record?.metrics.rowCount, 1_000);
  assert.equal(record?.metrics.payloadBytes, 6);
  assert.equal(record?.metrics.resultClass, 'success');
  assert.equal('accountId' in (record?.metrics ?? {}), false);
  assert.equal(JSON.stringify(record).includes('acct_secret'), false);
});

test('performance spans discard arbitrary result and error text', () => {
  globalThis.__KORDI_PERF_DIAGNOSTICS__ = true;
  withoutPerformanceDebug(() => {
    const span = beginChatPerformanceSpan('cloud-agent-ownership-guard');
    assert.ok(span);
    finishChatPerformanceSpan(span, {
      resultClass: 'provider body with a secret' as never,
      error: 'raw provider body' as never,
    });
  });

  const [record] = readChatPerformanceRecords();
  assert.deepEqual(record?.metrics, {});
  assert.equal(JSON.stringify(record).includes('secret'), false);
  assert.equal(JSON.stringify(record).includes('provider body'), false);
});

test('session click correlation stays internal and completes only for the matching transcript', () => {
  globalThis.__KORDI_PERF_DIAGNOSTICS__ = true;
  withoutPerformanceDebug(() => {
    startSessionClickToFirstMessage('session:private-value');
    completeSessionClickToFirstMessage('session:other', {
      messageCount: 10,
      visibleRowCount: 5,
    });
    assert.deepEqual(readChatPerformanceRecords(), []);

    completeSessionClickToFirstMessage('session:private-value', {
      messageCount: 10,
      visibleRowCount: 5,
    });
  });

  const [record] = readChatPerformanceRecords();
  assert.equal(record?.name, 'session-click-to-first-message');
  assert.deepEqual(record?.metrics, { messageCount: 10, visibleRowCount: 5 });
  assert.equal(JSON.stringify(record).includes('session:private-value'), false);
});

test('Cloud index instrumentation records aggregate sizes without source values', () => {
  globalThis.__KORDI_PERF_DIAGNOSTICS__ = true;
  withoutPerformanceDebug(() => {
    buildCloudMessageIndex('acct_private', {});
  });

  const [record] = readChatPerformanceRecords();
  assert.equal(record?.name, 'cloud-message-index');
  assert.deepEqual(record?.metrics, { messageCount: 0, rowCount: 0, payloadBytes: 0 });
  assert.equal(JSON.stringify(record).includes('acct_private'), false);
});

test('repeated spans replace the browser performance measure instead of accumulating entries', () => {
  globalThis.__KORDI_PERF_DIAGNOSTICS__ = true;
  const originalPerformance = globalThis.performance;
  const clearedNames: string[] = [];
  const measuredNames: string[] = [];
  let nowMs = 0;
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: {
      now: () => {
        nowMs += 1;
        return nowMs;
      },
      clearMeasures: (name: string) => clearedNames.push(name),
      measure: (name: string) => measuredNames.push(name),
    } as unknown as Performance,
  });
  try {
    finishChatPerformanceSpan(
      beginChatPerformanceSpan('transcript-virtual-render'),
      { visibleRowCount: 12 },
    );
    finishChatPerformanceSpan(
      beginChatPerformanceSpan('transcript-virtual-render'),
      { visibleRowCount: 13 },
    );
  } finally {
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: originalPerformance,
    });
  }

  assert.deepEqual(clearedNames, [
    'kordi:transcript-virtual-render',
    'kordi:transcript-virtual-render',
  ]);
  assert.deepEqual(measuredNames, [
    'kordi:transcript-virtual-render',
    'kordi:transcript-virtual-render',
  ]);
});

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
  // eslint-disable-next-line no-var
  var __KORDI_PERF_DIAGNOSTICS__: boolean | undefined;
}

test.beforeEach(() => {
  delete globalThis.__KORDI_PERF_DIAGNOSTICS__;
  clearChatPerformanceRecords();
});

test.after(() => {
  delete globalThis.__KORDI_PERF_DIAGNOSTICS__;
});

test('performance spans stay disabled outside Vite development without an explicit flag', () => {
  const span = beginChatPerformanceSpan('canonical-page-ipc');
  assert.equal(span, null);
  assert.deepEqual(readChatPerformanceRecords(), []);
});

test('performance spans expose only fixed numeric counts and payload bytes', () => {
  globalThis.__KORDI_PERF_DIAGNOSTICS__ = true;
  const originalDebug = console.debug;
  console.debug = () => {};
  try {
    const span = beginChatPerformanceSpan('cloud-message-index');
    assert.ok(span);
    finishChatPerformanceSpan(span, () => ({
      messageCount: 20_000,
      rowCount: 1_000,
      payloadBytes: chatPerformancePayloadBytes('你好'),
      accountId: 'acct_secret',
    } as never));
  } finally {
    console.debug = originalDebug;
  }

  const [record] = readChatPerformanceRecords();
  assert.equal(record?.name, 'cloud-message-index');
  assert.equal(record?.metrics.messageCount, 20_000);
  assert.equal(record?.metrics.rowCount, 1_000);
  assert.equal(record?.metrics.payloadBytes, 6);
  assert.equal('accountId' in (record?.metrics ?? {}), false);
  assert.equal(JSON.stringify(record).includes('acct_secret'), false);
});

test('session click correlation stays internal and completes only for the matching transcript', () => {
  globalThis.__KORDI_PERF_DIAGNOSTICS__ = true;
  const originalDebug = console.debug;
  console.debug = () => {};
  try {
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
  } finally {
    console.debug = originalDebug;
  }

  const [record] = readChatPerformanceRecords();
  assert.equal(record?.name, 'session-click-to-first-message');
  assert.deepEqual(record?.metrics, { messageCount: 10, visibleRowCount: 5 });
  assert.equal(JSON.stringify(record).includes('session:private-value'), false);
});

test('Cloud index instrumentation records aggregate sizes without source values', () => {
  globalThis.__KORDI_PERF_DIAGNOSTICS__ = true;
  const originalDebug = console.debug;
  console.debug = () => {};
  try {
    buildCloudMessageIndex('acct_private', {});
  } finally {
    console.debug = originalDebug;
  }

  const [record] = readChatPerformanceRecords();
  assert.equal(record?.name, 'cloud-message-index');
  assert.deepEqual(record?.metrics, { messageCount: 0, rowCount: 0, payloadBytes: 0 });
  assert.equal(JSON.stringify(record).includes('acct_private'), false);
});

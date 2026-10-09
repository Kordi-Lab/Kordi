import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudSelfAgentLocalRequestToStop, cloudSelfAgentStopOrder } from '../src/features/cloud/cloudSelfAgentStopOrder';

const sessionId = 'synthetic-stop-order';
const request = (messageId: string, minute: number) => ({ messageId, createdAt: `2026-10-09T12:${String(minute).padStart(2, '0')}:00.000Z` });

test('a stop tries the newest unfinished request first and a stale older one last', () => {
  const order = cloudSelfAgentStopOrder([request('stale', 1), request('running', 5), request('middle', 3)], new Set());
  assert.deepEqual(order.map(item => item.messageId), ['running', 'middle', 'stale']);
});

test('a stop tries the request with a live local turn first', () => {
  const order = cloudSelfAgentStopOrder([request('older-local', 1), request('newer', 5)], new Set(['older-local']));
  assert.deepEqual(order.map(item => item.messageId), ['older-local', 'newer']);
});

test('the local request to stop is the one with a live turn, else the newest started', () => {
  const active = new Map([
    ['stale', { sessionId, label: 'stale' }],
    ['running', { sessionId, label: 'running' }],
    ['newest', { sessionId, label: 'newest' }],
    ['other', { sessionId: 'other-session', label: 'other' }],
  ]);
  assert.equal(cloudSelfAgentLocalRequestToStop(active, sessionId, new Set(['running']))?.label, 'running');
  assert.equal(cloudSelfAgentLocalRequestToStop(active, sessionId, new Set())?.label, 'newest');
  assert.equal(cloudSelfAgentLocalRequestToStop(active, 'missing', new Set()), null);
});

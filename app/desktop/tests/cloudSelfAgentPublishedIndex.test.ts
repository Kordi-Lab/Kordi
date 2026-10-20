import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudSelfAgentPublishedMessageEntersIndex } from '../src/features/cloud/cloudSelfAgentForwardPolicy';

const route = { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' };
const historySession = () => false;

test('a live hosted request enters the index without waiting for a full sync', () => {
  assert.equal(cloudSelfAgentPublishedMessageEntersIndex({ sessionId: 's', agentRuntimeRoute: route }, historySession), true);
});

test('history rows and recovered requests still wait for the sync', () => {
  assert.equal(cloudSelfAgentPublishedMessageEntersIndex({ sessionId: 's' }, historySession), false);
  assert.equal(cloudSelfAgentPublishedMessageEntersIndex({ sessionId: 's', agentRuntimeRoute: route, historyOnly: true }, historySession), false);
  assert.equal(cloudSelfAgentPublishedMessageEntersIndex({ sessionId: 's', agentRuntimeRoute: route, queued: true }, historySession), false);
  assert.equal(cloudSelfAgentPublishedMessageEntersIndex({ sessionId: 's' }, () => true), true);
});

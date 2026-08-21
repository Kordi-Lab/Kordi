import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  cloudGroupAgentGuardDecision,
} from '../src/features/cloud/cloudGroupAgentGuard';

const cloudGroupAgentExecutionSource = () => readFileSync(
  new URL('../src/features/cloud/cloudGroupAgentExecution.ts', import.meta.url),
  'utf8',
);

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('history and fallback ownership guards start concurrently', async () => {
  const starts: string[] = [];
  const decision = cloudGroupAgentGuardDecision({
    loadMessages: async () => {
      starts.push('history');
      return [];
    },
    fallbackOwnsRequest: async () => {
      starts.push('fallback');
      return false;
    },
    responseExists: () => false,
  });

  assert.deepEqual(starts.sort(), ['fallback', 'history']);
  assert.deepEqual(await decision, {
    requestAlreadyOwned: false,
    resultClass: 'success',
  });
});

test('slow Cloud guards are independently bounded', async () => {
  const never = new Promise<never>(() => undefined);
  const startedAt = Date.now();
  const decision = await cloudGroupAgentGuardDecision({
    loadMessages: () => never,
    fallbackOwnsRequest: () => never,
    responseExists: () => false,
    timeoutMs: 10,
  });

  assert.deepEqual(decision, {
    requestAlreadyOwned: false,
    resultClass: 'timeout',
  });
  assert.ok(Date.now() - startedAt < 250);
});

test('either guard can prevent duplicate terminal fanout', async () => {
  assert.deepEqual(await cloudGroupAgentGuardDecision({
    loadMessages: async () => [],
    fallbackOwnsRequest: async () => true,
    responseExists: () => false,
  }), {
    requestAlreadyOwned: true,
    resultClass: 'owned-elsewhere',
  });
  assert.deepEqual(await cloudGroupAgentGuardDecision({
    loadMessages: async () => ['terminal'],
    fallbackOwnsRequest: async () => false,
    responseExists: (messages) => messages.includes('terminal'),
  }), {
    requestAlreadyOwned: true,
    resultClass: 'owned-elsewhere',
  });
});

test('failed guards are classified without leaking the thrown value', async () => {
  const decision = await cloudGroupAgentGuardDecision({
    loadMessages: async () => {
      throw new Error('private response body');
    },
    fallbackOwnsRequest: async () => false,
    responseExists: () => false,
  });

  assert.deepEqual(decision, {
    requestAlreadyOwned: false,
    resultClass: 'failed',
  });
  assert.equal(JSON.stringify(decision).includes('private response body'), false);
});

test('terminal persistence precedes slow activity and ownership publication', () => {
  const source = cloudGroupAgentExecutionSource();
  const terminalUpsert = source.indexOf(
    "beginChatPerformanceSpan(\n    'cloud-agent-terminal-upsert'",
  );
  const activityPublish = source.indexOf(
    "beginChatPerformanceSpan(\n    'cloud-agent-activity-publish'",
    terminalUpsert,
  );
  const terminalFanout = source.indexOf(
    'void publishCloudGroupAgentTerminalAfterGuards({',
    terminalUpsert,
  );

  assert.ok(terminalUpsert >= 0, 'expected terminal canonical upsert');
  assert.ok(activityPublish > terminalUpsert, 'activity must follow terminal persistence');
  assert.ok(terminalFanout > terminalUpsert, 'Cloud guards must follow terminal persistence');
});

test('group terminal fanout preserves only sanitized linked background tools', () => {
  const execution = cloudGroupAgentExecutionSource();
  const publication = source('../src/features/cloud/cloudGroupAgentPublication.ts');
  const application = source('../src/features/cloud/cloudGroupMessageControl.ts');

  assert.match(execution, /responseTools: cloudAgentPublicBackgroundToolsFromTurn\(finalTurn\)/);
  assert.match(publication, /structuredContent: responseTools\.length > 0/);
  assert.match(application, /content: senderIsAgent \? \{\s*\.\.\.structuredContent,/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const desktopSource = () => readFileSync(new URL('../src/lib/desktop.ts', import.meta.url), 'utf8');
const cloudDirectAgentExecutionSource = () => readFileSync(new URL('../src/features/cloud/useCloudDirectAgentExecution.ts', import.meta.url), 'utf8');
const cloudGroupAgentExecutionSource = () => readFileSync(new URL('../src/features/cloud/cloudGroupAgentExecution.ts', import.meta.url), 'utf8');

test('desktop chat start message forwards visible scheduled-task session id to Tauri', () => {
  const source = desktopSource();
  const start = source.indexOf('export async function startDesktopChatMessage');
  const end = source.indexOf('export type DesktopShapeAgentRoute', start);
  assert.ok(start >= 0 && end > start, 'expected startDesktopChatMessage implementation');
  const block = source.slice(start, end);

  assert.match(block, /scheduledTaskSessionId:\s*string\s*\|\s*null/);
  assert.match(block, /scheduledTaskSessionId,\s*\n\s*}\)/);
});

test('cloud group agent scheduling uses the visible group session id, not the hidden runtime session id', () => {
  const source = cloudGroupAgentExecutionSource();
  const runtimeStart = source.indexOf('startedTurn = await startDesktopChatMessage(');
  const turnStarted = source.indexOf('rememberLocalTurn(startedTurn);', runtimeStart);
  assert.ok(runtimeStart >= 0 && turnStarted > runtimeStart, 'expected group cloud agent start block');
  const block = source.slice(runtimeStart, turnStarted);

  assert.match(block, /startDesktopChatMessage\([\s\S]*cloudVisibleTaskRecordsForSession\([\s\S]*envelope\.groupId,\s*\n\s*\),\s*\n\s*envelope\.groupId,\s*\n\s*\)/);
});

test('direct contact agent scheduling uses the visible contact activity session id, not the hidden runtime session id', () => {
  const source = cloudDirectAgentExecutionSource();
  const runtimeStart = source.indexOf('const runtimeSessionId =');
  const publishStart = source.indexOf('if (activitySessionId) {', runtimeStart);
  assert.ok(runtimeStart >= 0 && publishStart > runtimeStart, 'expected direct contact cloud agent start block');
  const block = source.slice(runtimeStart, publishStart);

  assert.match(block, /startDesktopChatMessage\([\s\S]*visibleTaskRecords,\s*\n\s*activitySessionId,\s*\n\s*\)/);
});

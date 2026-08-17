import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendOrReplaceTrailingSessionConfigNotice,
  collapseAdjacentSessionConfigNotices,
  isSessionConfigNoticeMessage,
} from '../src/features/chat/sessionConfigNotices';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';

test('detects local session model/thinking change notices', () => {
  assert.equal(isSessionConfigNoticeMessage({ role: 'system', text: 'Switched model to openai/gpt-5.5', detail: 'Model updated' }), true);
  assert.equal(isSessionConfigNoticeMessage({ role: 'system', text: 'Thinking set to High', detail: 'Thinking updated' }), true);
  assert.equal(isSessionConfigNoticeMessage({ role: 'system', text: 'Model: openai/gpt-5.6-sol · Thinking effort: High', detail: 'Runtime updated' }), true);
  assert.equal(isSessionConfigNoticeMessage({ role: 'system', text: 'Session ready', detail: undefined }), false);
  assert.equal(isSessionConfigNoticeMessage({ role: 'user', text: 'Switched model to openai/gpt-5.5', detail: 'Model updated' }), false);
});

test('renders a synced model-change event as the same centered system notice', () => {
  const mapped = mapCanonicalMessage({
    id: 'model-change-cloud',
    sessionId: 'session:self-agent:default',
    senderIdentityId: 'human:me',
    senderRole: 'user',
    messageKind: 'agent-model-change',
    contentText: 'Switched model to anthropic/claude-opus-4-1',
    status: 'complete',
    sequenceNum: 2,
    createdAtMs: 2,
    updatedAtMs: 2,
  }, new Map());

  assert.equal(mapped?.role, 'system');
  assert.equal(mapped?.text, 'Switched model to anthropic/claude-opus-4-1');
  assert.equal(isSessionConfigNoticeMessage(mapped), true);
});

test('replaces a trailing session config notice instead of stacking model changes', () => {
  const first = { role: 'system', text: 'Switched model to anthropic/claude-opus-4-6', detail: 'Model updated', timeLabel: '22:08', timestampMs: 1 };
  const second = { role: 'system', text: 'Switched model to openai/gpt-5.5', detail: 'Model updated', timeLabel: '22:09', timestampMs: 2 };

  const result = appendOrReplaceTrailingSessionConfigNotice([first], second);

  assert.equal(result.appended, false);
  assert.deepEqual(result.messages, [second]);
});

test('keeps only the latest adjacent session config notice in the visible transcript', () => {
  const userMessage = { role: 'user', text: 'hello', time: '22:08' };
  const first = { role: 'system', text: 'Switched model to anthropic/claude-opus-4-6', detail: 'Model updated', time: '22:08' };
  const second = { role: 'system', text: 'Switched model to openai/gpt-5.5', detail: 'Model updated', time: '22:09' };
  const later = { role: 'system', text: 'Thinking set to High', detail: 'Thinking updated', time: '22:10' };

  assert.deepEqual(collapseAdjacentSessionConfigNotices([userMessage, first, second, userMessage, later]), [
    userMessage,
    second,
    userMessage,
    later,
  ]);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendOrReplaceTrailingSessionConfigNotice,
  collapseAdjacentSessionConfigNotices,
  isSessionConfigNoticeMessage,
} from '../src/features/chat/sessionConfigNotices';

test('detects local session model/thinking change notices', () => {
  assert.equal(isSessionConfigNoticeMessage({ role: 'system', text: 'Switched model to openai/gpt-5.5', detail: 'Model updated' }), true);
  assert.equal(isSessionConfigNoticeMessage({ role: 'system', text: 'Thinking set to High', detail: 'Thinking updated' }), true);
  assert.equal(isSessionConfigNoticeMessage({ role: 'system', text: 'Session ready', detail: undefined }), false);
  assert.equal(isSessionConfigNoticeMessage({ role: 'user', text: 'Switched model to openai/gpt-5.5', detail: 'Model updated' }), false);
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

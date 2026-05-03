import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUEUED_DESKTOP_MESSAGES_STORAGE_KEY,
  loadQueuedDesktopMessagesBySession,
  saveQueuedDesktopMessagesBySession,
} from '../src/features/chat/queuedDesktopMessages';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

test('queued desktop message storage loads persisted queue records', () => {
  const storage = new MemoryStorage();
  storage.setItem(QUEUED_DESKTOP_MESSAGES_STORAGE_KEY, JSON.stringify({
    'session-a': [{
      id: 'queued-1',
      sessionId: 'session-a',
      scope: 'chat',
      text: 'next ask',
      time: '12:34',
      attachments: [{ id: 'att-1', path: '/tmp/a.png', kind: 'image', name: 'a.png' }],
    }],
  }));

  assert.deepEqual(loadQueuedDesktopMessagesBySession(storage), {
    'session-a': [{
      id: 'queued-1',
      sessionId: 'session-a',
      scope: 'chat',
      text: 'next ask',
      time: '12:34',
      attachments: [{ id: 'att-1', path: '/tmp/a.png', kind: 'image', name: 'a.png' }],
    }],
  });
});

test('queued desktop message storage ignores missing or malformed persisted data', () => {
  const storage = new MemoryStorage();

  assert.deepEqual(loadQueuedDesktopMessagesBySession(storage), {});

  storage.setItem(QUEUED_DESKTOP_MESSAGES_STORAGE_KEY, 'not-json');
  assert.deepEqual(loadQueuedDesktopMessagesBySession(storage), {});

  storage.setItem(QUEUED_DESKTOP_MESSAGES_STORAGE_KEY, JSON.stringify(['not', 'a', 'session-map']));
  assert.deepEqual(loadQueuedDesktopMessagesBySession(storage), {});
});

test('queued desktop message storage writes non-empty queues and removes empty queues', () => {
  const storage = new MemoryStorage();

  saveQueuedDesktopMessagesBySession({
    'session-a': [{
      id: 'queued-1',
      sessionId: 'session-a',
      scope: 'chat',
      text: 'next ask',
      time: '12:34',
      attachments: [],
    }],
  }, storage);

  assert.equal(storage.getItem(QUEUED_DESKTOP_MESSAGES_STORAGE_KEY), JSON.stringify({
    'session-a': [{
      id: 'queued-1',
      sessionId: 'session-a',
      scope: 'chat',
      text: 'next ask',
      time: '12:34',
      attachments: [],
    }],
  }));

  saveQueuedDesktopMessagesBySession({ 'session-a': [] }, storage);
  assert.equal(storage.getItem(QUEUED_DESKTOP_MESSAGES_STORAGE_KEY), null);
});

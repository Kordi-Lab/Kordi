import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUEUED_DESKTOP_MESSAGES_STORAGE_KEY,
  loadQueuedDesktopMessagesBySession,
  removeQueuedDesktopMessageById,
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

test('queued desktop message storage treats unavailable browser storage as best-effort', () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const fakeWindow = {};
  Object.defineProperty(fakeWindow, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('localStorage unavailable');
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  });

  try {
    assert.deepEqual(loadQueuedDesktopMessagesBySession(), {});
    assert.doesNotThrow(() => saveQueuedDesktopMessagesBySession({ 'session-a': [] }));
  } finally {
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});

test('removeQueuedDesktopMessageById removes only the targeted queued message', () => {
  const current = {
    'session-a': [
      { id: 'queued-1', sessionId: 'session-a', scope: 'chat' as const, text: 'first', time: '12:34', attachments: [] },
      { id: 'queued-2', sessionId: 'session-a', scope: 'chat' as const, text: 'second', time: '12:35', attachments: [] },
      { id: 'queued-3', sessionId: 'session-a', scope: 'chat' as const, text: 'third', time: '12:36', attachments: [] },
    ],
    'session-b': [
      { id: 'queued-b', sessionId: 'session-b', scope: 'chat' as const, text: 'other session', time: '12:37', attachments: [] },
    ],
  };

  assert.deepEqual(removeQueuedDesktopMessageById(current, 'session-a', 'queued-2'), {
    'session-a': [current['session-a'][0], current['session-a'][2]],
    'session-b': current['session-b'],
  });
});

test('removeQueuedDesktopMessageById drops the session key after removing the final queued message', () => {
  const current = {
    'session-a': [
      { id: 'queued-1', sessionId: 'session-a', scope: 'chat' as const, text: 'first', time: '12:34', attachments: [] },
    ],
    'session-b': [
      { id: 'queued-b', sessionId: 'session-b', scope: 'chat' as const, text: 'other session', time: '12:37', attachments: [] },
    ],
  };

  assert.deepEqual(removeQueuedDesktopMessageById(current, 'session-a', 'queued-1'), {
    'session-b': current['session-b'],
  });
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

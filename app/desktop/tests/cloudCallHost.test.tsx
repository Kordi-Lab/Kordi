import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CloudCallHost } from '../src/features/cloud/CloudCallHost';
import { recoveryContent } from '../src/features/cloud/cloudCallSurfaceSupport';
import type { CloudCallsController } from '../src/features/cloud/cloudCallController';

test('minimizing a call keeps the remote audio element mounted', () => {
  const audioTrack = {
    attach: (element: HTMLMediaElement) => element,
    detach: (element: HTMLMediaElement) => element,
  };
  const call = {
    id: 'call-1',
    revision: 1,
    conversationId: 'conversation-1',
    kind: 'voice' as const,
    state: 'active' as const,
    createdByAccountId: 'acct_me',
    createdAt: '2026-08-15T09:00:00Z',
    answeredAt: '2026-08-15T09:00:01Z',
    endedAt: null,
    participants: [],
  };
  const controller = {
    account: { accountId: 'acct_me' },
    callsBySessionId: {},
    currentCall: { call, sessionId: 'session-1' },
    incomingCall: null,
    handoffCall: null,
    phase: 'connected',
    error: null,
    isPresented: false,
    isMicrophoneEnabled: true,
    isCameraEnabled: false,
    isAudioPlaybackBlocked: false,
    connectedAtMs: Date.now(),
    mediaParticipants: [{
      accountId: 'acct_peer',
      name: 'Peer',
      avatarUrl: null,
      isLocal: false,
      isSpeaking: false,
      microphoneEnabled: true,
      cameraEnabled: false,
      audioTrack,
      videoTrack: null,
    }],
    mediaDevices: [],
    activeDeviceIds: {},
    canSelectAudioOutput: false,
  } as unknown as CloudCallsController;

  const markup = renderToStaticMarkup(createElement(CloudCallHost, { controller }));
  assert.match(markup, /<audio/);
  assert.doesNotMatch(markup, /app-call-surface/);
});

test('an idle call lifecycle never shows a stale connection error', () => {
  const controller = {
    currentCall: null,
    incomingCall: null,
    handoffCall: null,
    phase: 'idle',
    error: 'The call disconnected. Check your connection and try joining again.',
    mediaParticipants: [],
  } as unknown as CloudCallsController;

  const idleMarkup = renderToStaticMarkup(createElement(CloudCallHost, { controller }));
  assert.doesNotMatch(idleMarkup, /Connection lost/);

  const failedMarkup = renderToStaticMarkup(createElement(CloudCallHost, {
    controller: { ...controller, phase: 'failed' },
  }));
  assert.match(failedMarkup, /role="dialog"/);
  assert.match(failedMarkup, /Connection lost/);
  assert.match(failedMarkup, /Check your network, then try again\./);
  assert.match(failedMarkup, />OK</);
  assert.doesNotMatch(failedMarkup, /app-call-error|Dismiss call error/);
});

function openCallController(overrides: Partial<Record<string, unknown>>) {
  const call = {
    id: 'call-open',
    revision: 1,
    conversationId: 'conversation-1',
    kind: 'voice' as const,
    state: 'active' as const,
    createdByAccountId: 'acct_me',
    createdAt: '2026-08-15T09:00:00Z',
    answeredAt: '2026-08-15T09:00:01Z',
    endedAt: null,
    participants: [],
  };
  return {
    account: { accountId: 'acct_me' },
    currentCall: { call, sessionId: 'session-1' },
    incomingCall: null,
    handoffCall: null,
    phase: 'connected',
    error: null,
    isPresented: true,
    isMicrophoneEnabled: true,
    isCameraEnabled: false,
    isAudioPlaybackBlocked: false,
    connectedAtMs: null,
    mediaParticipants: [],
    mediaDevices: [],
    activeDeviceIds: {},
    canSelectAudioOutput: false,
    ...overrides,
  } as unknown as CloudCallsController;
}

test('an open call shows one error line above the controls instead of a card', () => {
  const failedMarkup = renderToStaticMarkup(createElement(CloudCallHost, {
    controller: openCallController({
      phase: 'failed',
      error: 'The call disconnected. Check your connection and try again.',
    }),
  }));
  assert.match(failedMarkup, /class="app-error-line app-call-notice"/);
  assert.match(failedMarkup, /Connection lost\. Your call is still open\./);
  assert.match(failedMarkup, /class="app-error-line-action">Try again</);
  assert.doesNotMatch(failedMarkup, /app-call-recovery|Dismiss call notice|role="dialog" aria-modal="true" aria-labelledby/);

  const audioMarkup = renderToStaticMarkup(createElement(CloudCallHost, {
    controller: openCallController({ isAudioPlaybackBlocked: true }),
  }));
  assert.match(audioMarkup, /Audio is paused\./);
  assert.match(audioMarkup, /class="app-error-line-action">Start audio</);

  const switchMarkup = renderToStaticMarkup(createElement(CloudCallHost, {
    controller: openCallController({
      error: 'Kordi could not switch the camera. Check macOS permissions and try again.',
    }),
  }));
  assert.match(switchMarkup, /Couldn&#x27;t switch the camera\./);
  assert.match(switchMarkup, /class="app-error-line-action">Dismiss</);

  const quietMarkup = renderToStaticMarkup(createElement(CloudCallHost, {
    controller: openCallController({}),
  }));
  assert.doesNotMatch(quietMarkup, /app-error-line/);
});

test('a detached call leaves chat usable with a compact return card', () => {
  const call = {
    id: 'call-detached',
    revision: 1,
    conversationId: 'conversation-1',
    kind: 'video' as const,
    state: 'active' as const,
    createdByAccountId: 'acct_me',
    createdAt: '2026-08-31T09:00:00Z',
    answeredAt: '2026-08-31T09:00:01Z',
    endedAt: null,
    participants: [],
  };
  const controller = {
    account: { accountId: 'acct_me' },
    currentCall: null,
    incomingCall: null,
    handoffCall: null,
    detachedCall: { call, sessionId: 'session-1' },
    detachedThumbnailUrl: 'data:image/jpeg;base64,AA==',
    isDetachedCallFolded: true,
    phase: 'idle',
    error: null,
    mediaParticipants: [],
    showWindow: async () => undefined,
  } as unknown as CloudCallsController;

  const markup = renderToStaticMarkup(createElement(CloudCallHost, { controller }));
  assert.match(markup, /Call active in a separate window/);
  assert.match(markup, /Open call window/);
  assert.match(markup, /<img src="data:image\/jpeg;base64,AA==" alt=""/);
  assert.doesNotMatch(markup, />Call active in a separate window<\/span>/);
  assert.doesNotMatch(markup, /app-call-surface/);

  const openWindowMarkup = renderToStaticMarkup(createElement(CloudCallHost, {
    controller: { ...controller, isDetachedCallFolded: false },
  }));
  assert.doesNotMatch(openWindowMarkup, /app-call-card-detached/);

  const handoffMarkup = renderToStaticMarkup(createElement(CloudCallHost, {
    controller: {
      ...controller,
      detachedCall: null,
      handoffCall: { call, sessionId: 'session-1' },
      isDetachedCallFolded: false,
    },
  }));
  assert.doesNotMatch(handoffMarkup, /app-call-card/);

  const avatarMarkup = renderToStaticMarkup(createElement(CloudCallHost, {
    controller: { ...controller, detachedThumbnailUrl: null },
  }));
  assert.match(avatarMarkup, /app-call-detached-avatar/);
});

test('the full call surface does not repeat its title and phase in the header', () => {
  const call = {
    id: 'call-1',
    revision: 1,
    conversationId: 'conversation-1',
    kind: 'voice' as const,
    state: 'ringing' as const,
    createdByAccountId: 'acct_me',
    createdAt: '2026-08-15T09:00:00Z',
    answeredAt: null,
    endedAt: null,
    participants: [{
      accountId: 'acct_peer',
      displayName: 'Call Test B',
      avatarUrl: null,
      state: 'invited' as const,
    }],
  };
  const controller = {
    account: { accountId: 'acct_me' },
    currentCall: { call, sessionId: 'session-1' },
    incomingCall: null,
    handoffCall: null,
    phase: 'ringing',
    error: null,
    isPresented: true,
    isMicrophoneEnabled: true,
    isCameraEnabled: false,
    isAudioPlaybackBlocked: false,
    connectedAtMs: null,
    mediaParticipants: [],
    mediaDevices: [],
    activeDeviceIds: {},
    canSelectAudioOutput: false,
  } as unknown as CloudCallsController;

  const markup = renderToStaticMarkup(createElement(CloudCallHost, { controller }));
  assert.doesNotMatch(markup, /app-call-surface-heading|app-call-phase-dot/);
  assert.doesNotMatch(markup, />Kordi call</);
  assert.match(markup, /class="sr-only" role="status" aria-live="polite">Ringing/);
});

test('device and publication failures are not mislabeled as network loss', () => {
  assert.deepEqual(
    recoveryContent('Kordi could not find the microphone or camera needed for this call.', 'failed'),
    {
      title: 'Microphone or camera unavailable',
      description: 'Connect a microphone or camera, then try again.',
      line: "Couldn't find a microphone or camera.",
    },
  );
  assert.deepEqual(
    recoveryContent('Camera publication failed. Check camera access and try again.', 'failed'),
    {
      title: 'Call media unavailable',
      description: 'Some audio or video could not connect.',
      line: 'Some audio or video could not connect.',
    },
  );
});

test('device switch failures name the device instead of a permission notice', () => {
  for (const device of ['microphone', 'camera', 'speaker']) {
    const content = recoveryContent(
      `Kordi could not switch the ${device}. Check macOS permissions and try again.`,
      'connected',
    );
    assert.equal(content.title, `Couldn't switch the ${device}`);
    assert.equal(content.line, `Couldn't switch the ${device}.`);
  }
  assert.equal(
    recoveryContent('Kordi could not read the media devices on this Mac. Check System Settings and try again.', 'connected').title,
    "Couldn't read call devices",
  );
  for (const content of [
    recoveryContent('Kordi could not switch the camera. Check macOS permissions and try again.', 'connected'),
    recoveryContent('Speaker selection uses the output chosen in macOS System Settings on this Mac.', 'connected'),
  ]) {
    assert.notEqual(content.title, 'Check your call devices');
    assert.notEqual(content.title, 'Microphone or camera unavailable');
  }
});

test('blocked call devices ask in a dialog instead of an error notice', () => {
  const controller = {
    currentCall: null,
    incomingCall: null,
    handoffCall: null,
    phase: 'idle',
    error: null,
    mediaParticipants: [],
    permissionIssue: { sources: ['microphone'], canOpenSettings: true },
  } as unknown as CloudCallsController;

  const markup = renderToStaticMarkup(createElement(CloudCallHost, { controller }));
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /Allow microphone access/);
  assert.match(markup, /Open System Settings/);
  assert.match(markup, />Cancel</);
  assert.doesNotMatch(markup, /app-call-error/);

  const browserMarkup = renderToStaticMarkup(createElement(CloudCallHost, {
    controller: { ...controller, permissionIssue: { sources: ['microphone', 'camera'], canOpenSettings: false } },
  }));
  assert.match(browserMarkup, /Allow microphone and camera access/);
  assert.match(browserMarkup, /browser&#x27;s site settings/);
  assert.doesNotMatch(browserMarkup, /Open System Settings/);
});

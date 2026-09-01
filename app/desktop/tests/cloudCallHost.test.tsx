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
  assert.match(failedMarkup, /Connection lost/);
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
      description: 'Kordi could not find the microphone or camera needed for this call.',
    },
  );
  assert.deepEqual(
    recoveryContent('Camera publication failed. Check camera access and try again.', 'failed'),
    {
      title: 'Call media unavailable',
      description: 'Camera publication failed. Check camera access and try again.',
    },
  );
});

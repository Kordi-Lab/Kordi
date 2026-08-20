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

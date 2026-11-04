import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Room, RoomEvent } from 'livekit-client';
import { useCloudCalls } from '../src/features/cloud/useCloudCalls';
import type { CloudCallsController } from '../src/features/cloud/cloudCallController';
import type { CloudAccount, CloudAuthClient } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { CLOUD_CALLS_CHANGED_EVENT, normalizeCloudCall } from '../src/features/cloud/cloudCalls';
import { installDom, flushReactUpdates } from './helpers/transcriptAttachmentDom';

const wire = {
  id: 'synthetic-call', conversation_id: 'synthetic-conversation', kind: 'voice',
  state: 'active', created_by_account_id: 'synthetic-peer',
  created_at: '2026-11-03T10:00:00Z', answered_at: '2026-11-03T10:00:01Z',
  ended_at: null, participants: [],
};
const call = normalizeCloudCall(wire)!;
const account = { accountId: 'synthetic-owner' } as CloudAccount;
const conversations = [{ id: 'synthetic-session', canonicalSessionId: 'synthetic-session' }];

for (const scenario of ['remote-ended', 'local-ended', 'network-failure', 'lookup-failure', 'late-event', 'late-lookup'] as const) {
  test(`call teardown: ${scenario}`, async () => {
    const { dom, restore } = installDom();
    const root = createRoot(document.createElement('div'));
    let controller!: CloudCallsController;
    const media: { room?: Room } = {};
    let ended = false;
    let lookupFails = false;
    let holdLookup = false;
    let finishLookup: (() => void) | undefined;
    __setSessionBackendForTests({
      load: async () => ({ token: 'synthetic-token', accountId: account.accountId, expiresAt: '2099-01-01' }),
      save: async () => {}, clear: async () => {},
    });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [] }),
    } });
    const originalOn = Room.prototype.on;
    const subscriptions = mock.method(Room.prototype, 'on', function (this: Room, ...args: Parameters<Room['on']>) {
      if (media.room !== this) {
        media.room = this;
        mock.method(this, 'connect', async () => {});
        mock.method(this, 'startAudio', async () => {});
        mock.method(this, 'disconnect', async () => { this.emit(RoomEvent.Disconnected); });
        mock.method(this.localParticipant, 'setMicrophoneEnabled', async () => undefined);
      }
      return originalOn.apply(this, args);
    });
    const endedCall = normalizeCloudCall({ ...wire, state: 'ended', ended_at: '2026-11-03T10:01:00Z' })!;
    const client = { request: async (path: string) => {
      if (path.endsWith('/join')) return { call: wire, media: { url: 'wss://synthetic.invalid', token: 'synthetic-media' } };
      if (path.endsWith('/end')) {
        ended = true;
        media.room!.emit(RoomEvent.Disconnected);
        return { call: { ...wire, state: 'ended', ended_at: endedCall.endedAt } };
      }
      if (holdLookup) {
        await new Promise<void>(resolve => { finishLookup = resolve; });
        return { calls: [{ call: wire, session_id: 'synthetic-session' }] };
      }
      if (lookupFails) throw new Error('Synthetic lookup unavailable');
      return { calls: ended ? [] : [{ call: wire, session_id: 'synthetic-session' }] };
    } } as unknown as CloudAuthClient;
    function Harness() { controller = useCloudCalls({ account, conversations, client }); return null; }
    try {
      await act(async () => root.render(<Harness />));
      await flushReactUpdates();
      await act(async () => controller.join(call, 'synthetic-session'));
      assert.equal(controller.phase, 'connected');
      if (scenario === 'local-ended') {
        await act(async () => controller.end());
      } else if (scenario === 'late-lookup') {
        holdLookup = true;
        await act(async () => { media.room!.emit(RoomEvent.Disconnected); });
        assert.ok(finishLookup);
        await act(async () => controller.end());
        await act(async () => finishLookup!());
      } else if (scenario === 'late-event') {
        await act(async () => window.dispatchEvent(new dom.window.CustomEvent(CLOUD_CALLS_CHANGED_EVENT, {
          detail: { accountId: account.accountId, calls: [{ call: endedCall, sessionId: 'synthetic-session' }] },
        })));
        await act(async () => { media.room!.emit(RoomEvent.Reconnecting); media.room!.emit(RoomEvent.Reconnected); });
      } else {
        ended = scenario === 'remote-ended';
        lookupFails = scenario === 'lookup-failure';
        await act(async () => { media.room!.emit(RoomEvent.Disconnected); });
      }
      await flushReactUpdates();
      if (scenario === 'network-failure' || scenario === 'lookup-failure') {
        assert.equal(controller.phase, 'failed');
        assert.ok(controller.currentCall);
        assert.match(controller.error!, /connection/i);
      } else {
        assert.equal(controller.phase, 'idle');
        assert.equal(controller.currentCall, null);
        assert.equal(controller.error, null);
        assert.equal(controller.isPresented, false);
        assert.deepEqual(controller.mediaParticipants, []);
      }
    } finally {
      await act(async () => root.unmount());
      subscriptions.mock.restore();
      __setSessionBackendForTests(null); restore();
    }
  });
}

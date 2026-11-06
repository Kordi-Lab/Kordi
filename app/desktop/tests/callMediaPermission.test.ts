import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  callPermissionCopy,
  callPermissionSettingsUrl,
  ensureCallMediaPermission,
  type CallMediaSource,
  type CallPermissionDeps,
} from '../src/features/cloud/callMediaPermission';

type NativeCall = { source: CallMediaSource; request: boolean };

function fakeStream() {
  const stopped: string[] = [];
  return {
    stopped,
    stream: { getTracks: () => [{ stop: () => stopped.push('audio') }, { stop: () => stopped.push('video') }] } as unknown as MediaStream,
  };
}

function nativeDeps(
  statuses: Record<CallMediaSource, string[]>,
  getUserMedia: CallPermissionDeps['getUserMedia'] = async () => fakeStream().stream,
) {
  const calls: NativeCall[] = [];
  const queues = { microphone: [...statuses.microphone], camera: [...statuses.camera] };
  const deps: CallPermissionDeps = {
    native: async (source, request) => {
      calls.push({ source, request });
      return queues[source].shift() ?? 'unknown';
    },
    getUserMedia,
  };
  return { deps, calls };
}

test('voice calls request only the microphone and continue once macOS grants it', async () => {
  const constraints: MediaStreamConstraints[] = [];
  const { stopped, stream } = fakeStream();
  const { deps, calls } = nativeDeps(
    { microphone: ['not_determined', 'granted'], camera: ['denied'] },
    async (value) => { constraints.push(value); return stream; },
  );
  const result = await ensureCallMediaPermission('voice', deps);
  assert.deepEqual(result, { status: 'granted' });
  assert.deepEqual(calls, [
    { source: 'microphone', request: false },
    { source: 'microphone', request: true },
  ]);
  assert.deepEqual(constraints, [{ audio: true, video: false }]);
  assert.deepEqual(stopped, ['audio', 'video']);
});

test('video calls ask for the camera too and report a refused prompt', async () => {
  let opened = false;
  const { deps, calls } = nativeDeps(
    { microphone: ['granted'], camera: ['not_determined', 'denied'] },
    async () => { opened = true; return fakeStream().stream; },
  );
  const result = await ensureCallMediaPermission('video', deps);
  assert.deepEqual(result, { status: 'blocked', issue: { sources: ['camera'], canOpenSettings: true } });
  assert.deepEqual(calls.map((call) => `${call.source}:${call.request}`), [
    'microphone:false',
    'camera:false',
    'camera:true',
  ]);
  assert.equal(opened, false, 'devices are not opened after a refusal');
});

test('previously denied and restricted access skip the system prompt', async () => {
  const { deps, calls } = nativeDeps({ microphone: ['denied'], camera: ['restricted'] });
  const result = await ensureCallMediaPermission('meeting', deps);
  assert.deepEqual(result, {
    status: 'blocked',
    issue: { sources: ['microphone', 'camera'], canOpenSettings: true },
  });
  assert.equal(calls.some((call) => call.request), false);
});

test('a web view refusal after macOS allowed access still opens the dialog', async () => {
  const { deps } = nativeDeps(
    { microphone: ['granted'], camera: ['granted'] },
    async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); },
  );
  const result = await ensureCallMediaPermission('video', deps);
  assert.deepEqual(result, {
    status: 'blocked',
    issue: { sources: ['microphone', 'camera'], canOpenSettings: true },
  });
});

test('a failed native check falls back to the web request', async () => {
  const deps: CallPermissionDeps = {
    native: async () => { throw new Error('Permission request timed out.'); },
    getUserMedia: async () => fakeStream().stream,
  };
  assert.deepEqual(await ensureCallMediaPermission('voice', deps), { status: 'granted' });
});

test('browsers rely on the site prompt and cannot open System Settings', async () => {
  const deps: CallPermissionDeps = {
    getUserMedia: async () => { throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); },
  };
  const result = await ensureCallMediaPermission('voice', deps);
  assert.deepEqual(result, { status: 'blocked', issue: { sources: ['microphone'], canOpenSettings: false } });
  assert.match(callPermissionCopy(result.status === 'blocked' ? result.issue : { sources: [], canOpenSettings: false }).description, /browser's site settings/);
});

test('missing devices are not treated as a permission problem', async () => {
  const deps: CallPermissionDeps = {
    getUserMedia: async () => { throw Object.assign(new Error('none'), { name: 'NotFoundError' }); },
  };
  await assert.rejects(ensureCallMediaPermission('voice', deps), { name: 'NotFoundError' });
});

test('dialog copy and settings panes match the blocked devices', () => {
  assert.deepEqual(callPermissionCopy({ sources: ['microphone'], canOpenSettings: true }), {
    title: 'Allow microphone access',
    description: 'Turn on Kordi in Privacy & Security › Microphone, then call again.',
  });
  assert.equal(callPermissionCopy({ sources: ['microphone', 'camera'], canOpenSettings: true }).title, 'Allow microphone and camera access');
  assert.equal(callPermissionSettingsUrl('microphone'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  assert.equal(callPermissionSettingsUrl('camera'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  CloudCallClient,
  callConnectionErrorMessage,
  cloudCallTargetForConversation,
  normalizeCloudCall,
  requestCallMediaAccess,
} from '../src/features/cloud/cloudCalls';
import {
  activeCallsBySessionId,
  callMutationCompleted,
  newestCloudCallSnapshot,
  reconcileCloudCallSnapshot,
  shouldApplyActiveCallSnapshot,
} from '../src/features/cloud/cloudCallState';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { ChatSyncSyncClient } from '../src/features/cloud/chatSyncSyncClient';
import type { CloudAuthClient } from '../src/features/cloud/authClient';
import type { ChatSyncConversation, ChatSyncSyncResponse } from '../src/features/cloud/chatSyncTypes';
import type { CanonicalSessionMessage, Conversation } from '../src/kordi-app/types';
import { completedCallStartMessageIds } from '../src/features/canonical/readModel/callActivity';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { cloudGroupIncomingMessageAlreadyApplied } from '../src/features/cloud/useCloudGroupControlApplication';

const account = {
  accountId: 'acct_me',
  displayName: 'Me',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  nodeId: null,
  passwordSet: true,
};

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'local-session',
    canonicalSessionId: 'session:direct:me:peer',
    name: 'Sam',
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: '',
    directness: '',
    participants: [],
    canonicalParticipants: [
      { id: 'me', name: 'Me', kind: 'human', role: 'member', humanId: 'acct_me' },
      { id: 'peer', name: 'Sam', kind: 'human', role: 'member', humanId: 'acct_peer' },
    ],
    messages: [],
    identity: {
      sourceHostId: 'cloud',
      localHumanId: 'acct_me',
      localHumanName: 'Me',
      remoteHumanId: 'acct_peer',
      remoteHumanName: 'Sam',
    },
    ...overrides,
  };
}

const apiCall = {
  id: '0198d604-9ea2-7d6f-a4d4-9a65203aa760',
  conversation_id: '0198d604-a348-7e43-823d-c8c764855c13',
  kind: 'video',
  state: 'ringing',
  created_by_account_id: 'acct_me',
  created_at: '2026-08-15T09:00:00Z',
  answered_at: null,
  ended_at: null,
  participants: [
    {
      account_id: 'acct_me',
      display_name: 'Me',
      avatar_url: null,
      state: 'joined',
      joined_at: '2026-08-15T09:00:00Z',
      left_at: null,
    },
  ],
};

test('call targets cover direct chats and group meetings but exclude forks', () => {
  assert.deepEqual(cloudCallTargetForConversation(account, conversation()), {
    sessionId: 'session:direct:me:peer',
    peerAccountId: 'acct_peer',
    kind: 'direct',
    memberAccountIds: ['acct_peer'],
    sharedTitle: null,
  });

  assert.deepEqual(cloudCallTargetForConversation(account, conversation({
    canonicalSessionId: 'session:group:friends',
    participantSpaceId: 'group:friends',
    name: 'Friends',
    canonicalParticipants: [
      { id: 'me', name: 'Me', kind: 'human', role: 'member', humanId: 'acct_me' },
      { id: 'one', name: 'One', kind: 'human', role: 'member', humanId: 'acct_one' },
      { id: 'two', name: 'Two', kind: 'human', role: 'member', humanId: 'acct_two' },
    ],
  })), {
    sessionId: 'session:group:friends',
    peerAccountId: 'acct_one',
    kind: 'group',
    memberAccountIds: ['acct_one', 'acct_two'],
    sharedTitle: 'Friends',
  });

  assert.equal(cloudCallTargetForConversation(account, conversation({
    forkedFromSessionId: 'session:self-agent:parent',
  })), null);
  assert.equal(cloudCallTargetForConversation(account, conversation({
    identity: {
      sourceHostId: 'local-bridge',
      localHumanId: 'human-local',
      localHumanName: 'Me',
      remoteHumanId: 'human-peer',
      remoteHumanName: 'Sam',
    },
    canonicalParticipants: [],
  })), null);
});

test('call client ensures the reliable conversation before starting media', async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  let ensuredInput: unknown;
  const transport = {
    async ensureChatConversation(_token: string, input: unknown) {
      ensuredInput = input;
      return { id: 'conversation-v2' } as ChatSyncConversation;
    },
    async request<T>(path: string, init: RequestInit) {
      requests.push({ path, init });
      return { call: apiCall, media: { url: 'wss://media.example', token: 'media-token' } } as T;
    },
  } as unknown as CloudAuthClient;
  const client = new CloudCallClient(transport);
  const target = cloudCallTargetForConversation(account, conversation());
  assert.ok(target);
  const result = await client.start('session-token', account.accountId, target, 'video');

  assert.equal(result.call.kind, 'video');
  assert.deepEqual(ensuredInput, {
    accountId: 'acct_me',
    peerAccountId: 'acct_peer',
    sessionId: 'session:direct:me:peer',
    kind: 'direct',
    memberAccountIds: ['acct_peer'],
    sharedTitle: null,
  });
  assert.equal(requests[0]?.path, '/v2/chat/conversations/conversation-v2/calls');
  assert.equal(requests[0]?.init.method, 'POST');
  const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
  assert.equal(body.kind, 'video');
  assert.match(String(body.client_operation_id), /^[0-9a-f-]{36}$/);
});

test('group call requests use the meeting media kind', async () => {
  let requestBody: Record<string, unknown> | null = null;
  const transport = {
    async ensureChatConversation() {
      return { id: 'group-conversation-v2' } as ChatSyncConversation;
    },
    async request<T>(_path: string, init: RequestInit) {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return {
        call: { ...apiCall, kind: 'meeting' },
        media: { url: 'wss://media.example', token: 'media-token' },
      } as T;
    },
  } as unknown as CloudAuthClient;
  const client = new CloudCallClient(transport);
  const target = cloudCallTargetForConversation(account, conversation({
    canonicalSessionId: 'session:group:friends',
    participantSpaceId: 'group:friends',
    canonicalParticipants: [
      { id: 'me', name: 'Me', kind: 'human', role: 'member', humanId: 'acct_me' },
      { id: 'one', name: 'One', kind: 'human', role: 'member', humanId: 'acct_one' },
      { id: 'two', name: 'Two', kind: 'human', role: 'member', humanId: 'acct_two' },
    ],
  }));
  assert.ok(target);
  const result = await client.start('session-token', account.accountId, target, 'meeting');

  assert.equal(result.call.kind, 'meeting');
  assert.equal(requestBody?.kind, 'meeting');
});

test('call media permission probe requests the right devices and releases them', async () => {
  const constraints: MediaStreamConstraints[] = [];
  let stopped = 0;
  const mediaDevices = {
    async getUserMedia(next: MediaStreamConstraints) {
      constraints.push(next);
      return {
        getTracks: () => [
          { stop: () => { stopped += 1; } },
          { stop: () => { stopped += 1; } },
        ],
      } as MediaStream;
    },
  };
  await requestCallMediaAccess('voice', mediaDevices as Pick<MediaDevices, 'getUserMedia'>);
  await requestCallMediaAccess('video', mediaDevices as Pick<MediaDevices, 'getUserMedia'>);
  assert.deepEqual(constraints, [
    { audio: true, video: false },
    { audio: true, video: true },
  ]);
  assert.equal(stopped, 4);
});

test('call connection failures identify signaling and ICE or TURN stages', () => {
  assert.match(callConnectionErrorMessage({ reasonName: 'WebSocket' }), /signaling/i);
  assert.match(callConnectionErrorMessage({ reasonName: 'Timeout' }), /ICE or TURN/i);
});

test('chat sync keeps call events and attaches the stable desktop session id', async () => {
  const chatConversation: ChatSyncConversation = {
    id: 'conversation-v2',
    kind: 'direct',
    shared_title: null,
    version: 1,
    created_by_account_id: 'acct_me',
    legacy_session_id: 'session:direct:me:peer',
    latest_message_sequence: 0,
    created_at: '2026-08-15T09:00:00Z',
    updated_at: '2026-08-15T09:00:00Z',
    members: [],
    preferences: {
      conversation_id: 'conversation-v2',
      account_id: 'acct_me',
      personal_title: null,
      version: 1,
    },
  };
  const response: ChatSyncSyncResponse = {
    protocol_version: 2,
    events: [{
      stream_seq: 8,
      event_id: 'call-event',
      protocol_version: 2,
      type: 'call.created',
      critical: true,
      conversation_id: chatConversation.id,
      entity_id: apiCall.id,
      entity_version: 1,
      occurred_at: '2026-08-15T09:00:00Z',
      payload: { call: apiCall },
    }],
    next_cursor: '8',
    last_stream_seq: 8,
    has_more: false,
    server_time: '2026-08-15T09:00:00Z',
  };
  const state = new ChatSyncState(
    async () => response,
    () => 'acct_me',
    () => undefined,
    () => null,
  );
  state.rememberConversation(chatConversation);
  const sync = new ChatSyncSyncClient(state);
  const result = await sync.syncCloudEvents('token', '7');

  assert.equal(result.events[0]?.eventType, 'call.created');
  assert.deepEqual(result.events[0]?.payload, {
    call: apiCall,
    sessionId: 'session:direct:me:peer',
  });
});

test('macOS bundle declares media privacy descriptions and hardened-runtime access', () => {
  const info = readFileSync(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8');
  const entitlements = readFileSync(new URL('../src-tauri/Entitlements.plist', import.meta.url), 'utf8');
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as {
    bundle?: { macOS?: { entitlements?: string } };
  };

  assert.match(info, /NSCameraUsageDescription/);
  assert.match(info, /NSMicrophoneUsageDescription/);
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(entitlements, /com\.apple\.security\.device\.camera/);
  assert.equal(config.bundle?.macOS?.entitlements, './Entitlements.plist');
});

test('call normalization rejects incomplete server snapshots', () => {
  assert.equal(normalizeCloudCall({ ...apiCall, kind: 'screen-share' }), null);
  assert.equal(normalizeCloudCall({ ...apiCall, id: '' }), null);
});

test('ended call snapshots cannot be revived as another-device calls', () => {
  const active = normalizeCloudCall(apiCall);
  const ended = normalizeCloudCall({
    ...apiCall,
    state: 'active',
    ended_at: '2026-08-15T09:01:00Z',
  });
  assert.ok(active);
  assert.ok(ended);
  assert.equal(ended.state, 'ended');

  const stale = { 'session:direct:me:peer': active };
  assert.deepEqual(reconcileCloudCallSnapshot(stale, ended, null), {});
  assert.deepEqual(activeCallsBySessionId(
    [{ call: active, sessionId: 'session:direct:me:peer' }],
    new Set(['session:direct:me:peer']),
    new Set([active.id]),
  ), {});
});

test('call revisions reject delayed active snapshots and keep end terminal', () => {
  const revisionTwo = normalizeCloudCall({ ...apiCall, revision: 2, state: 'active' });
  const delayed = normalizeCloudCall({ ...apiCall, revision: 1 });
  const ended = normalizeCloudCall({
    ...apiCall,
    revision: 3,
    state: 'ended',
    ended_at: '2026-08-15T09:01:00Z',
  });
  assert.ok(revisionTwo);
  assert.ok(delayed);
  assert.ok(ended);
  assert.equal(newestCloudCallSnapshot(revisionTwo, delayed), revisionTwo);
  assert.equal(newestCloudCallSnapshot(revisionTwo, ended), ended);
  assert.equal(newestCloudCallSnapshot(ended, revisionTwo), ended);

  const nextCall = { ...revisionTwo, id: 'next-call' };
  assert.equal(
    reconcileCloudCallSnapshot(
      { 'session:direct:me:peer': nextCall },
      ended,
      'session:direct:me:peer',
    )['session:direct:me:peer'],
    nextCall,
  );
});

test('local call UI closes only after the requested mutation is confirmed', () => {
  const active = normalizeCloudCall(apiCall);
  const ended = normalizeCloudCall({
    ...apiCall,
    state: 'ended',
    ended_at: '2026-08-15T09:01:00Z',
  });
  assert.ok(active);
  assert.ok(ended);
  assert.equal(callMutationCompleted('end', 'video', active), false);
  assert.equal(callMutationCompleted('end', 'video', null), false);
  assert.equal(callMutationCompleted('end', 'video', ended), true);
  assert.equal(callMutationCompleted('leave', 'video', active), false);
  assert.equal(callMutationCompleted('leave', 'meeting', active), true);
});

test('only the newest active-call snapshot may update the UI', () => {
  assert.equal(shouldApplyActiveCallSnapshot(4, 4, 7, 7), true);
  assert.equal(shouldApplyActiveCallSnapshot(3, 4, 7, 7), false);
  assert.equal(shouldApplyActiveCallSnapshot(4, 4, 6, 7), false);
});

test('call activity maps to one Telegram-style history record', () => {
  const callMessage: CanonicalSessionMessage = {
    id: 'call-ended-message',
    sessionId: 'session:direct:me:peer',
    senderIdentityId: 'me',
    senderRole: 'person',
    messageKind: 'call.ended.0198d604-9ea2-7d6f-a4d4-9a65203aa760',
    contentText: 'The voice call ended.',
    content: {
      callActivity: {
        schema: 1,
        callId: '0198d604-9ea2-7d6f-a4d4-9a65203aa760',
        kind: 'voice',
        event: 'ended',
        answeredAtMs: 1_000,
        durationSeconds: 65,
      },
    },
    status: 'sent',
    sequenceNum: 2,
    createdAtMs: 2_000,
    updatedAtMs: 2_000,
  };
  const mapped = mapCanonicalMessage(callMessage, new Map(), 'me');
  assert.deepEqual(mapped?.callActivity, {
    callId: '0198d604-9ea2-7d6f-a4d4-9a65203aa760',
    kind: 'voice',
    event: 'ended',
    direction: 'outgoing',
    outcome: 'completed',
    durationSeconds: 65,
  });
  assert.deepEqual([...completedCallStartMessageIds([
    { id: 'call-started-message', messageKind: 'call.started.0198d604-9ea2-7d6f-a4d4-9a65203aa760' },
    { id: callMessage.id, messageKind: callMessage.messageKind },
  ])], ['call-started-message']);
});

test('unanswered incoming calls map to missed-call history', () => {
  const callMessage: CanonicalSessionMessage = {
    id: 'missed-call-message',
    sessionId: 'session:direct:me:peer',
    senderIdentityId: 'peer',
    senderRole: 'person',
    messageKind: 'call.ended.missed-call',
    contentText: 'The video call ended.',
    content: {
      callActivity: {
        schema: 1,
        callId: 'missed-call',
        kind: 'video',
        event: 'ended',
        answeredAtMs: null,
        durationSeconds: null,
      },
    },
    status: 'sent',
    sequenceNum: 3,
    createdAtMs: 3_000,
    updatedAtMs: 3_000,
  };
  assert.equal(
    mapCanonicalMessage(callMessage, new Map(), 'me')?.callActivity?.outcome,
    'missed',
  );
});

test('group call history advances one canonical row from started to ended', () => {
  const callId = '0198d604-9ea2-7d6f-a4d4-9a65203aa760';
  const started: CanonicalSessionMessage = {
    id: 'call-history-message',
    sessionId: 'session:group:friends',
    senderIdentityId: 'me',
    senderRole: 'user',
    messageKind: `call.started.${callId}`,
    contentText: 'Me started a video chat.',
    content: null,
    status: 'sent',
    sequenceNum: 1,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };

  assert.equal(
    cloudGroupIncomingMessageAlreadyApplied(
      started,
      null,
      `call.ended.${callId}`,
    ),
    false,
  );
  assert.equal(
    cloudGroupIncomingMessageAlreadyApplied(
      { ...started, messageKind: `call.ended.${callId}` },
      null,
      `call.started.${callId}`,
    ),
    true,
  );
});

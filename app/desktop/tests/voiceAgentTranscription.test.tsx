import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { useChatMessageActions } from '../src/features/chat/messageActions/chatMessages';
import type { UseChatMessageActionsArgs } from '../src/features/chat/messageActions/types';
import type { AttachmentItem } from '../src/features/chat/composerController.types';
import { resetVoiceTranscriptionJobsForTests } from '../src/features/chat/voiceTranscriptionJobs';
import { setCloudVoiceTranscriptClientForTests, type VoiceTranscriptClient } from '../src/features/cloud/cloudVoiceTranscriptPersistence';
import { voiceForAgentExecution, waitForVoiceTranscriptForAgent, VOICE_AGENT_TRANSCRIPT_WAIT_MS } from '../src/features/cloud/cloudVoiceAgentGate';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useCloudDirectAgentExecution } from '../src/features/cloud/useCloudDirectAgentExecution';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import type { CloudAccount, CloudAuthClient, CloudMessage, CloudVoiceMessage } from '../src/features/cloud/authClient';
import type { CanonicalSessionState, DesktopChatTurnSnapshot, DesktopCollaborationState } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture as avatar } from './helpers/cloudAccountAvatarFixture';
import type { VoiceTranscription } from '../src/features/chat/voiceTranscription';

const noop = () => {};
const pendingTranscription = (sourceVersion: string): VoiceTranscription => ({
  status: 'pending', sourceVersion, engine: 'apple-speech-v1', attempts: 0,
});

function voiceAttachment(path: string): AttachmentItem {
  return {
    id: `voice:${path}`, name: 'Voice message.m4a', path, localPath: path, kind: 'file', mimeType: 'audio/mp4',
    formatLabel: 'M4A', sizeBytes: 4096,
    voiceMessage: { mimeType: 'audio/mp4', durationMs: 2000, waveformSamples: [0.2], transcript: '',
      transcription: pendingTranscription('draft-version'), localPath: path },
  };
}

type SpeechControl = { calls: string[]; requested: (count: number) => Promise<void>; release: (text: string) => Promise<void> };

async function withSendHarness(
  extraIpc: (command: string, payload: Record<string, unknown>) => unknown,
  run: (root: Root, speech: SpeechControl) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const values = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true, __TAURI_INTERNALS__: {} };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const calls: string[] = [];
  const waiting: ((text: string) => void)[] = [];
  mockIPC((command, payload) => {
    if (command === 'desktop_voice_transcribe') {
      calls.push(String((payload as { path?: string }).path));
      return new Promise<string>(resolve => waiting.push(resolve));
    }
    return extraIpc(command, (payload ?? {}) as Record<string, unknown>);
  });
  __setSessionBackendForTests({
    load: async () => ({ token: 'synthetic-token', accountId: 'owner', expiresAt: '2999-01-01T00:00:00Z' }),
    save: async () => {}, clear: async () => {},
  });
  resetVoiceTranscriptionJobsForTests();
  const root = createRoot(document.getElementById('root')!);
  try {
    await run(root, {
      calls,
      requested: async (count) => {
        for (let attempt = 0; attempt < 200 && calls.length < count; attempt += 1) {
          await act(async () => { await new Promise(done => setTimeout(done, 10)); });
        }
      },
      release: async (text) => {
        for (let attempt = 0; attempt < 200 && waiting.length === 0; attempt += 1) {
          await act(async () => { await new Promise(done => setTimeout(done, 10)); });
        }
        const resolve = waiting.shift();
        assert.ok(resolve, 'speech recognition is waiting');
        await act(async () => { resolve(text); await new Promise(done => setTimeout(done, 20)); });
      },
    });
  } finally {
    await act(async () => root.unmount());
    setCloudVoiceTranscriptClientForTests(null);
    __setSessionBackendForTests(null);
    resetVoiceTranscriptionJobsForTests();
    clearMocks();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function cloudArgs(runtime: 'agent' | 'person', send: UseChatMessageActionsArgs['sendCloudCollaborationMessage']) {
  const host = { id: 'cloud', humanId: 'owner', nodeId: 'owner', ownerName: 'Owner', activeAgentId: 'cloud-agent:owner',
    agents: [], visiblePeers: [], projects: [] };
  return {
    activeConvId: `cloud:conversation:peer:${runtime}`, activeConvCanonicalSessionId: `session:direct-${runtime}:owner:peer`,
    activeConversationUsesCollaboration: true, activeConvMessages: [], chatConversations: [],
    activeConvCollaborationTarget: runtime === 'agent'
      ? { hostId: 'cloud', nodeId: 'peer', humanId: 'peer', runtime: 'agent', agentId: 'cloud_agent_synthetic', displayName: 'Synthetic Agent' }
      : { hostId: 'cloud', nodeId: 'peer', humanId: 'peer', runtime: 'person' },
    activeConvMentionScope: { id: `cloud:conversation:peer:${runtime}`, canonicalSessionId: `session:direct-${runtime}:owner:peer` },
    isNativeShell: true, hasAnyDesktopAuth: true, hasLocalProviderAuth: true, desktopChatState: null, canonicalSessionState: null,
    desktopCollaborationState: { activeHostId: 'cloud', hosts: [host], conversations: [] } as unknown as DesktopCollaborationState,
    desktopLiveTurn: null, queuedDesktopMessagesBySession: {},
    composerDrafts: { chat: '', project: '' }, composerSelections: { chat: { model: 'test', thinking: 'default', mode: 'agent' } },
    chatComposerAttachments: [], selectedChatAgentMentionRef: { current: null }, localChatSendInFlightRef: { current: null },
    shouldAutoFollowChatRef: { current: false }, attachmentSummaryText: (value: string) => value,
    resolveChatRuntimeRoute: () => null, handleLocalSlashCommand: async () => false,
    sendCloudCollaborationMessage: send,
    setComposerDrafts: noop, setActiveConvId: noop, setCanonicalSessionState: noop, setChatComposerAttachments: noop,
    setCloudCollaborationState: noop, setDesktopChatError: noop, setDesktopChatState: noop,
    setDesktopLiveTurnsBySession: noop, setIsDesktopChatSending: noop, setOpenComposerSelector: noop,
    setPendingUserChatMessage: noop, setQueuedDesktopMessagesBySession: noop,
  } as unknown as UseChatMessageActionsArgs;
}

function sentVoiceMessage(conversationId: string, voice: CloudVoiceMessage): CloudMessage {
  return { messageId: 'message-voice', conversationId, version: 1, fromAccountId: 'owner', toAccountId: 'peer',
    body: 'Voice message', createdAt: new Date().toISOString(), deliveredAt: null, readAt: null, direction: 'outgoing',
    voiceMessage: voice };
}

test('a voice message to a hosted agent uploads at once while transcription runs, then stores the transcript', async () => {
  await withSendHarness(() => undefined, async (root, speech) => {
    const puts: { version: number; mediaId: string; transcript: string; transcription: VoiceTranscription }[] = [];
    const client: VoiceTranscriptClient = { chat: {
      updateVoiceTranscript: async (_token, conversationId, _messageId, version, mediaId, transcript, transcription) => {
        puts.push({ version, mediaId, transcript, transcription });
        return sentVoiceMessage(conversationId, { mediaId, mimeType: 'audio/mp4', durationMs: 2000, waveformSamples: [0.2], transcript, transcription });
      },
      threadPage: async () => { throw new Error('No refresh expected.'); },
      listHistoryPage: async () => { throw new Error('No refresh expected.'); },
    } };
    setCloudVoiceTranscriptClientForTests(client);
    const events: string[] = [];
    const sends: { body: string; options: Record<string, unknown> | undefined }[] = [];
    const args = cloudArgs('agent', async (conversationId, body, _attachments, options) => {
      events.push(`send:${speech.calls.length}`);
      sends.push({ body, options: options as Record<string, unknown> | undefined });
      return sentVoiceMessage('conversation-agent', {
        mediaId: 'media-agent', mimeType: 'audio/mp4', durationMs: 2000, waveformSamples: [0.2], transcript: '',
        transcription: pendingTranscription('media-agent'),
      });
    });
    let actions!: ReturnType<typeof useChatMessageActions>;
    function Harness() { actions = useChatMessageActions(args); return null; }
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await actions.handleSendChatMessage('Voice message', undefined, [], [voiceAttachment('/synthetic/agent-send.m4a')]);
      await new Promise(done => setTimeout(done, 20));
    });
    assert.equal(sends.length, 1, 'upload and send never wait for transcription');
    await speech.requested(1);
    assert.deepEqual(speech.calls, ['/synthetic/agent-send.m4a'], 'the agent path transcribes in parallel');
    assert.equal(puts.length, 0, 'nothing is stored before recognition finishes');
    const voiceField = sends[0].options?.voiceMessage as { transcript: string; transcription: VoiceTranscription };
    assert.equal(voiceField.transcript, '');
    assert.equal(voiceField.transcription.status, 'pending');
    assert.equal(voiceField.transcription.attempts, 0);

    await speech.release('Summarize the plan.');
    assert.equal(puts.length, 1);
    assert.deepEqual(
      { version: puts[0].version, mediaId: puts[0].mediaId, transcript: puts[0].transcript,
        status: puts[0].transcription.status, attempts: puts[0].transcription.attempts, sourceVersion: puts[0].transcription.sourceVersion },
      { version: 1, mediaId: 'media-agent', transcript: 'Summarize the plan.', status: 'ready', attempts: 1, sourceVersion: 'media-agent' },
    );
  });
});

test('a voice message in a human chat sends without any speech recognition', async () => {
  await withSendHarness(() => undefined, async (root, speech) => {
    let sends = 0;
    const args = cloudArgs('person', async () => {
      sends += 1;
      return sentVoiceMessage('conversation-person', { mediaId: 'media-person', mimeType: 'audio/mp4', durationMs: 2000,
        waveformSamples: [0.2], transcript: '', transcription: pendingTranscription('media-person') });
    });
    let actions!: ReturnType<typeof useChatMessageActions>;
    function Harness() { actions = useChatMessageActions(args); return null; }
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await actions.handleSendChatMessage('Voice message', undefined, [], [voiceAttachment('/synthetic/person-send.m4a')]);
      await new Promise(done => setTimeout(done, 20));
    });
    assert.equal(sends, 1);
    assert.deepEqual(speech.calls, []);
  });
});

test('a local agent voice message is delivered once, never returns to sending, and the turn starts with the transcript', async () => {
  const sessionId = 'session:local-voice-agent';
  const writes: { command: string; status: string; transcript: string }[] = [];
  const turnStarts: string[] = [];
  await withSendHarness((command, payload) => {
    if (command === 'desktop_chat_session_active_turn') return null;
    if (command === 'desktop_canonical_append_message_fast' || command === 'desktop_canonical_upsert_message_fast') {
      const request = payload.request as { id: string; sessionId: string; status: string; content: { voiceMessage?: { transcript: string } } };
      writes.push({ command, status: request.status, transcript: request.content.voiceMessage?.transcript ?? '' });
      return { ...request, sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1 };
    }
    if (command === 'desktop_chat_start_message') {
      turnStarts.push(String(payload.text));
      return { id: 'turn-voice', sessionId, prompt: String(payload.text), status: 'running', message: '', assistantText: '',
        thinkingText: '', tools: [], completed: false, succeeded: false, startedAtMs: Date.now() };
    }
    return undefined;
  }, async (root, speech) => {
    let canonical = {
      profile: { humanIdentityId: 'human:me' }, identities: [], delegatedExchanges: [],
      sessions: [{ id: sessionId, kind: 'self-agent', title: 'Voice agent', status: 'active', updatedAtMs: 1 }], messages: [],
    } as unknown as CanonicalSessionState;
    const statuses: string[] = [];
    const inFlight = { current: null as { sessionId: string | null } | null };
    const args = {
      ...cloudArgs('person', async () => assert.fail('A local agent send never reaches Cloud.')),
      activeConvId: sessionId, activeConvCanonicalSessionId: sessionId, activeConversationUsesCollaboration: false,
      activeConvCollaborationTarget: null, activeConvMentionScope: { id: sessionId, canonicalSessionId: sessionId },
      desktopCollaborationState: null, canonicalHumanIdentityId: 'human:me', canonicalSessionState: canonical,
      desktopChatState: { activeSessionId: sessionId, activeSession: { id: sessionId, messages: [], messageCount: 0, title: 'Voice agent' },
        sessions: [], projects: [] },
      localChatSendInFlightRef: inFlight,
      watchDesktopLiveTurn: () => new Promise<void>(() => {}),
      setCanonicalSessionState: (update: CanonicalSessionState | ((current: CanonicalSessionState | null) => CanonicalSessionState | null)) => {
        canonical = (typeof update === 'function' ? update(canonical) : update) ?? canonical;
        const status = canonical.messages.find(message => message.sessionId === sessionId)?.status;
        if (status && statuses.at(-1) !== status) statuses.push(status);
      },
    } as unknown as UseChatMessageActionsArgs;
    let actions!: ReturnType<typeof useChatMessageActions>;
    function Harness() { actions = useChatMessageActions(args); return null; }
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await actions.handleSendChatMessage('Voice message', undefined, [], [voiceAttachment('/synthetic/local-agent.m4a')]);
      await new Promise(done => setTimeout(done, 20));
    });
    assert.deepEqual(statuses, ['sending', 'sent'], 'delivery completes before transcription finishes');
    await speech.requested(1);
    assert.deepEqual(speech.calls, ['/synthetic/local-agent.m4a']);
    assert.deepEqual(turnStarts, [], 'the agent turn waits for the words');
    assert.deepEqual(inFlight.current, { sessionId }, 'later messages to this agent queue behind the voice request');

    await speech.release('Open the release notes.');
    assert.equal(turnStarts.length, 1);
    assert.match(turnStarts[0], /audio was not provided/);
    assert.match(turnStarts[0], /Open the release notes\.$/);
    assert.deepEqual(statuses, ['sending', 'sent'], 'the transcript update keeps the delivered status');
    const voiceMessage = canonical.messages[0].content as { voiceMessage: { transcript: string; transcription: VoiceTranscription } };
    assert.equal(voiceMessage.voiceMessage.transcript, 'Open the release notes.');
    assert.equal(voiceMessage.voiceMessage.transcription.status, 'ready');
    const firstSent = writes.findIndex(write => write.status === 'sent');
    assert.ok(firstSent > 0);
    assert.ok(writes.slice(firstSent).every(write => write.status === 'sent'), `stored status never returns to sending: ${JSON.stringify(writes)}`);
    assert.equal(writes.at(-1)?.transcript, 'Open the release notes.');
  });
});

test('agent executors wait a bounded time for a not-yet-transcribed voice request', async () => {
  const pending = { mediaId: 'media-gate', mimeType: 'audio/mp4', durationMs: 2000, waveformSamples: [0.2], transcript: '',
    transcription: pendingTranscription('media-gate') };
  const createdAt = new Date(1_000_000).toISOString();
  assert.deepEqual(
    voiceForAgentExecution({ voice: pending, createdAt, waitingSinceMs: 1_000_000, nowMs: 1_010_000 }),
    { status: 'waiting', retryAtMs: 1_000_000 + VOICE_AGENT_TRANSCRIPT_WAIT_MS },
  );
  const timedOut = voiceForAgentExecution({ voice: pending, createdAt, waitingSinceMs: 1_000_000, nowMs: 1_000_000 + VOICE_AGENT_TRANSCRIPT_WAIT_MS });
  assert.equal(timedOut.status, 'ready', 'after the bounded wait the turn proceeds with the pending text');
  const ready = { ...pending, transcript: 'Hello.', transcription: { ...pending.transcription, status: 'ready' as const, attempts: 1 } };
  assert.equal(voiceForAgentExecution({ voice: ready, createdAt, waitingSinceMs: 1_000_000, nowMs: 1_000_001 }).status, 'ready');
  const failed = { ...pending, transcription: { ...pending.transcription, status: 'failed' as const, attempts: 1 } };
  assert.equal(voiceForAgentExecution({ voice: failed, createdAt, waitingSinceMs: 1_000_000, nowMs: 1_000_001 }).status, 'ready');

  let now = 2_000_000;
  let latest: CloudVoiceMessage = pending;
  const sleeps: number[] = [];
  const voice = await waitForVoiceTranscriptForAgent({
    latestVoice: () => latest,
    createdAt: new Date(now).toISOString(),
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      if (sleeps.length === 3) latest = ready;
    },
  });
  assert.equal(voice?.transcript, 'Hello.', 'message.updated with the transcript releases the wait');
  assert.equal(sleeps.length, 3);
});

test('the owner executor does not start an agent turn until the sender stores the voice transcript', async () => {
  await withSendHarness(() => undefined, async (root) => {
    __setSessionBackendForTests({ load: async () => null, save: async () => {}, clear: async () => {} });
    const owner: CloudAccount = { accountId: 'owner', displayName: 'Owner', primaryEmail: 'owner@example.test', avatarUrl: null, avatar, nodeId: 'owner', passwordSet: true };
    const voice: CloudVoiceMessage = { mediaId: 'media-request', mimeType: 'audio/mp4', durationMs: 2000, waveformSamples: [0.2],
      transcript: '', transcription: pendingTranscription('media-request') };
    const request: CloudMessage = { messageId: 'request-voice', conversationId: 'conversation-request', version: 1,
      fromAccountId: 'peer', toAccountId: 'owner', sessionId: 'session:direct-person:owner:peer', createdAt: new Date().toISOString(),
      deliveredAt: null, readAt: null, direction: 'incoming', voiceMessage: voice,
      body: encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: 'Voice message',
        targetCloudAgentId: 'cloud-agent:owner', targetCloudAgentName: 'Owner Assistant', targetCloudAgentOwnerAccountId: 'owner' }) };
    let turns: Record<string, DesktopChatTurnSnapshot> = {};
    const processed = new Set<string>();
    const render = (message: CloudMessage) => {
      const args: Parameters<typeof useCloudDirectAgentExecution>[0] = {
        account: owner, client: {} as CloudAuthClient, cloudAgentDefinitionsById: {}, cloudLookupContacts: [],
        cloudMessageIndex: buildCloudMessageIndex(owner.accountId, { peer: [message] }), initialMessagesSettled: true, runtimeReady: true,
        processedRequestIdsRef: { current: processed }, turnIdsByRequestIdRef: { current: new Map() },
        activityRef: { current: { tasksBySessionId: {}, artifactsBySessionId: {} } },
        setLocalTurns: update => { turns = typeof update === 'function' ? update(turns) : update; },
        setActivity: noop, mergeMessage: noop, syncMessages: async () => {}, reportWarning: noop,
      };
      function Harness() { useCloudDirectAgentExecution(args); return null; }
      return act(async () => { root.render(<Harness />); await new Promise(done => setTimeout(done, 20)); });
    };
    await render(request);
    assert.equal(processed.size, 0, 'a voice request sent without transcription waits');
    assert.deepEqual(turns, {});

    await render({ ...request, version: 2, voiceMessage: { ...voice, transcript: 'Book the room.',
      transcription: { ...voice.transcription!, status: 'ready', attempts: 1, language: 'en-US' } } });
    assert.ok(processed.has('request-voice'), 'message.updated with the transcript releases the request');
    assert.match(turns['request-voice']?.prompt ?? '', /Book the room\.$/);
  });
});

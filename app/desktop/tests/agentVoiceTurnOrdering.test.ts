import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SetStateAction } from 'react';
import { JSDOM } from 'jsdom';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import {
  dispatchLocalAgentVoiceTurn,
  type LocalAgentTurnContext,
} from '../src/features/chat/messageActions/localAgentTurnDispatch';
import { prepareCanonicalUserMessage } from '../src/features/chat/messageActions/optimistic';
import {
  AGENT_VOICE_TRANSCRIPT_TIMEOUT_ERROR,
  agentVoiceTranscriptionWithin,
} from '../src/features/chat/messageActions/voiceAgentTranscription';
import type { AttachmentItem } from '../src/features/chat/composerController.types';
import { voiceAgentText, type VoiceTranscriptionOutcome } from '../src/features/chat/voiceTranscription';
import { planCloudSelfAgentSync } from '../src/features/cloud/cloudSelfAgentForwardSync';
import { localSelfAgentRequestVoice } from '../src/features/cloud/cloudSelfAgentExecutionState';
import { cloudSelfAgentRequestClientMessageId } from '../src/features/cloud/cloudSelfAgentIdentity';
import type { CanonicalSessionState, DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const sessionId = 'session-voice-1';
const hostedRoute = { model: 'openai-codex/gpt-5.5', authProvider: 'openai-codex', authChoice: 'cloud-login:saved', thinking: 'medium' };
const TRANSCRIPT_NOTE = /^\[Voice transcript; audio was not provided\./;

function voiceAttachment(path: string): AttachmentItem {
  return {
    id: `voice:${path}`, name: 'Voice message.m4a', path, localPath: path, kind: 'file', mimeType: 'audio/mp4',
    formatLabel: 'M4A', sizeBytes: 4096,
    voiceMessage: { mimeType: 'audio/mp4', durationMs: 2000, waveformSamples: [0.2], transcript: '',
      transcription: { status: 'pending', sourceVersion: 'draft-version', engine: 'apple-speech-v1', attempts: 0 }, localPath: path },
  };
}

type Harness = {
  writes: { status: string; contentText: string; route: unknown }[];
  turnStarts: string[];
  hostedWaits: string[];
  errors: (string | null)[];
  state: () => CanonicalSessionState;
  messageId: string;
  settle: (predicate: () => boolean) => Promise<void>;
};

/** Sends one voice message through the local agent voice dispatch with a controllable transcription. */
async function withVoiceDispatch(
  route: LocalAgentTurnContext['route'],
  transcription: Promise<VoiceTranscriptionOutcome>,
  run: (harness: Harness) => Promise<void>,
  transcriptTimeoutMs?: number,
) {
  const dom = new JSDOM('<div></div>', { url: 'http://localhost' });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
  const writes: Harness['writes'] = [];
  const turnStarts: string[] = [];
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    if (command === 'desktop_canonical_upsert_message_fast') {
      const request = args.request as { status: string; contentText: string; content: { agentRuntimeRoute?: unknown } };
      writes.push({ status: request.status, contentText: request.contentText, route: request.content.agentRuntimeRoute });
      return { ...request, sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1 };
    }
    if (command === 'desktop_chat_start_message') {
      turnStarts.push(String(args.text));
      return { id: 'turn-voice', sessionId, prompt: String(args.text), status: 'running', message: '', assistantText: '',
        thinkingText: '', tools: [], completed: false, succeeded: false, startedAtMs: 1 };
    }
    return undefined;
  });
  const attachments = [voiceAttachment('/synthetic/agent-voice.m4a')];
  const prepared = prepareCanonicalUserMessage(sessionId, 'human:me', 'Voice message', attachments, '12:31', 'desktop-chat-ui');
  assert.ok(prepared);
  let state = {
    sessions: [{ id: sessionId, kind: 'self-agent', status: 'active', updatedAtMs: 1 }],
    messages: [{ ...prepared.request, sequenceNum: 1, updatedAtMs: 1 }],
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' },
  } as unknown as CanonicalSessionState;
  const hostedWaits: string[] = [];
  const errors: (string | null)[] = [];
  const context: LocalAgentTurnContext = {
    targetConversationId: sessionId, canonicalSessionId: sessionId, canonicalSessionState: state,
    text: 'Voice message', attachmentPaths: attachments.map((item) => item.path), route, contextMessages: [],
    setCanonicalSessionState: (update: SetStateAction<CanonicalSessionState | null>) => {
      state = (typeof update === 'function' ? update(state) : update) ?? state;
    },
    setDesktopChatError: (error) => { errors.push(error); },
    watchTurn: (_turn: DesktopChatTurnSnapshot) => undefined,
  };
  try {
    dispatchLocalAgentVoiceTurn(context, prepared, attachments, transcription, {
      clearInFlight: () => undefined,
      flushQueue: () => undefined,
      waitForHostedRequest: (requestMessageId) => { hostedWaits.push(requestMessageId); },
    }, transcriptTimeoutMs);
    await run({
      writes, turnStarts, hostedWaits, errors, state: () => state, messageId: prepared.messageId,
      settle: async (predicate) => {
        for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await new Promise((done) => setTimeout(done, 5));
      },
    });
  } finally {
    clearMocks();
    dom.window.close();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The prompt the executing Mac gives the agent for the forwarded request. */
function executorPrompt(state: CanonicalSessionState, messageId: string) {
  const voice = localSelfAgentRequestVoice(state, { clientMessageId: cloudSelfAgentRequestClientMessageId(sessionId, messageId) });
  assert.ok(voice, 'the executor finds the voice of its own forwarded request');
  return voiceAgentText(voice);
}

test('the agent wait for a transcript is bounded and a late result becomes the failed marker', async () => {
  const late = await agentVoiceTranscriptionWithin(new Promise<VoiceTranscriptionOutcome>(() => {}), 10);
  assert.deepEqual(late, { status: 'failed', error: AGENT_VOICE_TRANSCRIPT_TIMEOUT_ERROR });
  const ready = await agentVoiceTranscriptionWithin(Promise.resolve({ status: 'ready', transcript: 'Hi.', language: 'en-US' }), 10_000);
  assert.equal(ready.status, 'ready');
});

test('a Kordi Cloud voice request is not delivered until its transcript is on the message', async () => {
  const speech = deferred<VoiceTranscriptionOutcome>();
  await withVoiceDispatch(hostedRoute, speech.promise, async (harness) => {
    await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(harness.writes, [], 'nothing is delivered while transcription runs');
    assert.equal(harness.state().messages[0].status, 'sending');
    assert.deepEqual(planCloudSelfAgentSync(harness.state(), {}), [], 'forward sync has no execution request to publish yet');

    speech.resolve({ status: 'ready', transcript: 'Book the room for Friday.', language: 'en-US' });
    await harness.settle(() => harness.hostedWaits.length > 0);
    assert.deepEqual(harness.writes.map((write) => [write.status, write.contentText]), [['sent', 'Book the room for Friday.']],
      'one delivery write carries the transcript');
    assert.deepEqual(harness.writes[0].route, hostedRoute);
    assert.deepEqual(harness.hostedWaits, [harness.messageId]);
    assert.deepEqual(harness.turnStarts, [], 'a Kordi Cloud request never starts a native turn directly');
    const operations = planCloudSelfAgentSync(harness.state(), {});
    assert.equal(operations.length, 1);
    assert.equal(operations[0].text, 'Book the room for Friday.');
    const prompt = executorPrompt(harness.state(), harness.messageId);
    assert.match(prompt, TRANSCRIPT_NOTE);
    assert.match(prompt, /\nBook the room for Friday\.$/);
  });
});

test('a Kordi Cloud voice request without permission is delivered with the unavailable marker', async () => {
  const denied = Promise.resolve<VoiceTranscriptionOutcome>({
    status: 'unavailable', error: 'Allow Kordi to use Speech Recognition in System Settings and try again.',
  });
  await withVoiceDispatch(hostedRoute, denied, async (harness) => {
    await harness.settle(() => harness.hostedWaits.length > 0);
    assert.deepEqual(harness.writes.map((write) => write.contentText), ['Voice message']);
    const prompt = executorPrompt(harness.state(), harness.messageId);
    assert.equal(prompt, '[Voice message: Transcript unavailable for this recording. No spoken content or audio was provided to the agent.]');
  });
});

test('a Kordi Cloud voice request whose transcript times out is delivered with the failed marker', async () => {
  await withVoiceDispatch(hostedRoute, new Promise<VoiceTranscriptionOutcome>(() => {}), async (harness) => {
    await harness.settle(() => harness.hostedWaits.length > 0);
    assert.equal(harness.writes.length, 1, 'the request is never held past the bounded wait');
    const prompt = executorPrompt(harness.state(), harness.messageId);
    assert.equal(prompt, '[Voice message: Transcription failed. No spoken content or audio was provided to the agent.]');
  }, 20);
});

test('a native local agent turn starts with the transcript, or with the failed marker after the bounded wait', async () => {
  const speech = deferred<VoiceTranscriptionOutcome>();
  await withVoiceDispatch(null, speech.promise, async (harness) => {
    await harness.settle(() => harness.writes.length > 0);
    assert.equal(harness.writes[0]?.status, 'sent', 'a native local request is delivered at once');
    assert.deepEqual(harness.turnStarts, [], 'the turn waits for the words');
    speech.resolve({ status: 'ready', transcript: 'Open the notes.', language: 'en-US' });
    await harness.settle(() => harness.turnStarts.length > 0);
    assert.match(harness.turnStarts[0], TRANSCRIPT_NOTE);
    assert.match(harness.turnStarts[0], /\nOpen the notes\.$/);
  });
  await withVoiceDispatch(null, new Promise<VoiceTranscriptionOutcome>(() => {}), async (harness) => {
    await harness.settle(() => harness.turnStarts.length > 0);
    assert.deepEqual(harness.turnStarts, [
      '[Voice message: Transcription failed. No spoken content or audio was provided to the agent.]',
    ]);
  }, 20);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import React, { act } from 'react';

import { setMessageLayout } from '../src/app/messageLayoutPreference';
import { composerAgentRequestStop } from '../src/features/chat/agentRequestStop';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';
import { VoiceComposerControls } from '../src/pages/chatsPage.voiceControls';
import type { VoiceComposerController } from '../src/pages/chatsPage.voiceComposer';
import { turn } from './helpers/replyAttributionFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const idleVoice = { surfaceActive: false, recording: false, recorder: { start: async () => {} } } as unknown as VoiceComposerController;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

function streamingReply(overrides: Partial<Message> = {}): Message {
  return {
    id: 'reply',
    role: 'owned-agent',
    sender: "Main Test A's Kordi",
    senderOwnerName: 'You',
    text: '',
    time: '12:30',
    timestampMs: Date.UTC(2026, 9, 9, 12, 30),
    turn: turn({
      id: 'turn-story',
      status: 'writing',
      message: 'Replying',
      assistantText: 'Once upon a time, a long story began.\n\nIt kept going.',
      completed: false,
      succeeded: false,
      startedAtMs: Date.UTC(2026, 9, 9, 12, 30),
      sourceMessage: { messageId: 'request', senderLabel: 'Main Test A', senderIsSelf: true, text: 'Tell me a story' },
    }),
    ...overrides,
  };
}

test('composer shows Stop instead of Send while the viewer request runs, and calls the stop handler', async () => {
  let stops = 0;
  let sends = 0;
  let finishStop: (() => void) | undefined;
  const stop = composerAgentRequestStop({
    messages: [streamingReply()],
    onStopActiveTurn: () => new Promise<void>((resolve) => { stops += 1; finishStop = resolve; }),
  });
  assert.ok(stop);
  await withJsdomRoot(async (mount) => {
    const host = await mount(
      <VoiceComposerControls voice={idleVoice} hasSendableDraft activeLiveTurnIsRunning onSend={() => { sends += 1; }} stop={stop} />,
    );
    assert.equal(host.querySelector('button[aria-label="Send message"]'), null);
    const stopButton = host.querySelector<HTMLButtonElement>('button[aria-label="Stop"]');
    assert.ok(stopButton);
    assert.equal(stopButton.getAttribute('title'), 'Stop');
    await act(async () => { stopButton.click(); });
    await settle();
    assert.equal(stops, 1);
    assert.equal(sends, 0);
    assert.equal(stopButton.getAttribute('aria-busy'), 'true');
    await act(async () => { stopButton.click(); });
    await settle();
    assert.equal(stops, 1, 'a second click while stopping does not stop again');
    finishStop?.();

    await mount(<VoiceComposerControls voice={idleVoice} hasSendableDraft activeLiveTurnIsRunning={false} onSend={() => { sends += 1; }} stop={null} />);
    assert.equal(host.querySelector('button[aria-label="Stop"]'), null);
    assert.ok(host.querySelector('button[aria-label="Send message"]'));
  });
});

test('composer Stop offers a retry when the stop handler stopped nothing or failed', async () => {
  const results: Array<boolean | undefined | Error> = [false, undefined, new Error('Unable to stop request'), true];
  let stops = 0;
  const onStop = async () => {
    const result = results[stops];
    stops += 1;
    if (result instanceof Error) throw result;
    return result;
  };
  await withJsdomRoot(async (mount) => {
    const host = await mount(
      <VoiceComposerControls voice={idleVoice} hasSendableDraft activeLiveTurnIsRunning onSend={() => {}} stop={{ requestKey: 'request-a', onStop }} />,
    );
    const stopButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')!;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await act(async () => { stopButton().click(); });
      await settle();
      assert.equal(stops, attempt);
      assert.equal(stopButton().getAttribute('aria-busy'), null, `attempt ${attempt} leaves Stop ready to retry`);
    }
    await act(async () => { stopButton().click(); });
    await settle();
    assert.equal(stops, 4);
    assert.equal(stopButton().getAttribute('aria-busy'), 'true', 'a reported stop spins until the request ends');

    await mount(
      <VoiceComposerControls voice={idleVoice} hasSendableDraft activeLiveTurnIsRunning onSend={() => {}} stop={{ requestKey: 'request-b', onStop }} />,
    );
    assert.equal(stopButton().getAttribute('aria-busy'), null, 'a new request starts with a fresh Stop');
  });
});

test('composer stop targets only running requests the viewer sent', () => {
  const onStopActiveTurn = () => {};
  const onStopCollaborationAgentRequest = () => {};
  const handlers = { onStopActiveTurn, onStopCollaborationAgentRequest };
  const finished = streamingReply({ turn: turn({ id: 'done' }) });
  assert.equal(composerAgentRequestStop({ messages: [finished], ...handlers }), null);

  const peerRequest = streamingReply();
  peerRequest.turn = { ...peerRequest.turn!, sourceMessage: { messageId: 'request', senderLabel: 'Peer', senderIsSelf: false, text: 'hi' } };
  assert.equal(composerAgentRequestStop({ messages: [peerRequest], ...handlers }), null);

  const peerAgent = streamingReply({ role: 'external-agent', senderOwnerName: 'Peer' });
  assert.equal(composerAgentRequestStop({ messages: [peerAgent], ...handlers }), null);

  const queued = streamingReply();
  queued.turn = { ...queued.turn!, status: 'queued', assistantText: '' };
  assert.equal(composerAgentRequestStop({ messages: [queued], ...handlers })?.requestKey, 'turn-story');

  const outreach = streamingReply({ role: 'external-agent', senderOwnerName: 'Peer' });
  outreach.turn = { ...outreach.turn!, id: 'outreach', pendingCollaborationAgentRequest: { conversationId: 'c', requestId: 'r' } };
  let stopped: unknown = null;
  const target = composerAgentRequestStop({
    messages: [outreach],
    onStopActiveTurn,
    onStopCollaborationAgentRequest: (request) => { stopped = request; },
  });
  assert.equal(target?.requestKey, 'outreach');
  void target?.onStop();
  assert.deepEqual(stopped, { conversationId: 'c', requestId: 'r' });

  assert.ok(composerAgentRequestStop({ messages: [], liveTurnIsRunning: true, ...handlers }));
  assert.equal(composerAgentRequestStop({ messages: [], liveTurnIsRunning: true, onStopCollaborationAgentRequest }), null);
});

test('the live reply header keeps Stop while text streams and drops it when the turn completes', async () => {
  let stops = 0;
  await withJsdomRoot(async (mount) => {
    await act(async () => { setMessageLayout('threads'); });
    const onStopActiveTurn = () => { stops += 1; };
    const host = await mount(<MessageBubble msg={streamingReply()} onStopActiveTurn={onStopActiveTurn} />);
    const header = host.querySelector('.app-thread-message-header')?.parentElement;
    assert.ok(header);
    assert.match(host.textContent ?? '', /Once upon a time/);
    const headerStop = header.querySelector<HTMLButtonElement>('[data-agent-request-stop="header"] button[aria-label="Stop agent request"]');
    assert.ok(headerStop, 'stop sits in the header while text streams');
    assert.equal(host.querySelectorAll('button[aria-label="Stop agent request"]').length, 1, 'the card does not repeat the stop');
    await act(async () => { headerStop.click(); });
    assert.equal(stops, 1);

    const completed = streamingReply();
    completed.turn = { ...completed.turn!, status: 'complete', completed: true, succeeded: true };
    await mount(<MessageBubble msg={completed} onStopActiveTurn={onStopActiveTurn} />);
    assert.equal(host.querySelector('button[aria-label="Stop agent request"]'), null);

    const peer = streamingReply({ id: 'peer-reply' });
    peer.turn = { ...peer.turn!, sourceMessage: { messageId: 'request', senderLabel: 'Peer', senderIsSelf: false, text: 'hi' } };
    await mount(<MessageBubble msg={peer} onStopActiveTurn={onStopActiveTurn} />);
    assert.equal(host.querySelector('button[aria-label="Stop agent request"]'), null, 'no stop on other people\'s requests');
    await act(async () => { setMessageLayout('chat'); });
  });
});

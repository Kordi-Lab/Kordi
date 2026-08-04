import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentStudioConversation } from '../src/kordi-app/agents/AgentStudioConversation';
import type { DesktopChatMessage, DesktopChatSessionDetail } from '../src/kordi-app/types';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => undefined },
    detachEvent: { configurable: true, value: () => undefined },
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  return {
    dom,
    restore() {
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}

function builderSession(messages: DesktopChatMessage[] = [{
  role: 'user',
  text: 'Make the instructions more concise',
  timeLabel: '10:26',
  timestampMs: 1,
}]): DesktopChatSessionDetail {
  return {
    id: 'session:agent-builder:test',
    cwd: '/tmp/agent-builder/workspace',
    title: 'Kordi Factory',
    subtitle: 'Kordi Factory workspace',
    provider: 'openai',
    providerLabel: 'OpenAI',
    model: 'gpt-test',
    modelLabel: 'GPT Test',
    thinking: 'medium',
    thinkingLabel: 'Medium',
    thinkingLevels: ['medium'],
    updatedAtLabel: '10:26',
    messageCount: messages.length,
    draft: false,
    contextWindowText: '1%',
    contextWindowStatus: { contextWindow: 100_000, autoCompaction: true },
    messages,
  };
}

test('Kordi Factory conversation uses the normal transcript identity and attachment controls', () => {
  const html = renderToStaticMarkup(
    <AgentStudioConversation
      targetName="Kordi"
      creating={false}
      localProfileAvatarSeed="shu-yang"
      localProfileDisplayName="Shu Yang"
      localProfileImageUrl="https://coordinar.io/profile/avatar.png"
      sessionId="session:agent-builder:test"
      detail={builderSession()}
      activeTurn={null}
      optimisticPrompt={null}
      opening={false}
      error={null}
      modelOptions={[{
        value: 'openai/gpt-test',
        label: 'GPT Test',
        provider: 'openai',
        providerLabel: 'OpenAI',
        thinkingLevels: ['medium', 'high'],
      }]}
      providerOptions={[{
        value: 'openai::oauth-test',
        providerId: 'openai',
        label: 'ChatGPT account',
        detail: 'owner@example.com',
        selectionLabel: 'ChatGPT account',
        active: true,
      }]}
      onSend={() => undefined}
      onStop={() => undefined}
      onOpenAuthSettings={() => undefined}
    />,
  );

  assert.match(html, /https:\/\/coordinar\.io\/profile\/avatar\.png/);
  assert.match(html, /Make the instructions more concise/);
  assert.match(html, /aria-label="Add attachment"/);
  assert.match(html, /data-composer-attachment-add-trigger="true"/);
  assert.match(html, /lucide-plus/);
  assert.doesNotMatch(html, /lucide-paperclip/);
  assert.match(html, /ChatGPT account/);
  assert.match(html, /GPT Test/);
  assert.match(html, /Medium/);
  assert.match(html, /Auto-compresses before Kordi responds once usage reaches 90%/);
  assert.match(html, /aria-label="Send to Kordi Factory"/);
  assert.doesNotMatch(html, /aria-label="Suggested requests"/);
  assert.doesNotMatch(html, /I want this agent to help me with…/);
  assert.doesNotMatch(html, /missing boundaries/);
  assert.doesNotMatch(html, /capability set/);
  assert.doesNotMatch(html, /Agent Builder/);
  assert.doesNotMatch(html, /Attachments are not available/);
});

test('new Factory builds offer plain-language creation prompts', () => {
  const html = renderToStaticMarkup(
    <AgentStudioConversation
      targetName="New build"
      creating
      sessionId="session:agent-builder:test"
      detail={builderSession([])}
      activeTurn={null}
      optimisticPrompt={null}
      opening={false}
      error={null}
      onSend={() => undefined}
      onStop={() => undefined}
    />,
  );

  assert.match(html, /I want to create an agent that helps me with…/);
  assert.match(html, /I want to create a skill for…/);
  assert.match(html, /I want to automate…/);
});

test('Factory suggestions fill the composer and disappear only after the first send', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let sendCount = 0;
  let root: Root | null = createRoot(host);

  try {
    await act(async () => {
      root?.render(
        <AgentStudioConversation
          targetName="Kordi"
          creating={false}
          sessionId={null}
          detail={null}
          activeTurn={null}
          optimisticPrompt={null}
          opening
          error={null}
          onSend={() => { sendCount += 1; }}
          onStop={() => undefined}
        />,
      );
    });

    const suggestion = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Review this agent for skills it does not need');
    assert.ok(suggestion);
    const attachmentTrigger = host.querySelector<HTMLButtonElement>('[data-composer-attachment-add-trigger="true"]');
    assert.ok(attachmentTrigger);
    assert.equal(attachmentTrigger.disabled, true);

    await act(async () => {
      suggestion.dispatchEvent(new installed.dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }));
    });

    const composer = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Kordi Factory"]');
    assert.ok(composer);
    assert.equal(composer.value, 'Review this agent for skills it does not need');
    assert.equal(document.activeElement, composer);
    assert.equal(sendCount, 0);

    await act(async () => {
      root?.render(
        <AgentStudioConversation
          targetName="Kordi"
          creating={false}
          sessionId="session:agent-builder:test"
          detail={builderSession([])}
          activeTurn={null}
          optimisticPrompt={null}
          opening={false}
          error={null}
          onSend={() => { sendCount += 1; }}
          onStop={() => undefined}
        />,
      );
    });

    assert.equal(composer.value, 'Review this agent for skills it does not need');
    assert.equal(sendCount, 0);

    const send = host.querySelector<HTMLButtonElement>('button[aria-label="Send to Kordi Factory"]');
    assert.ok(send);
    await act(async () => {
      send.dispatchEvent(new installed.dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }));
    });

    assert.equal(sendCount, 1);
    assert.equal(host.querySelector('[aria-label="Suggested requests"]'), null);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

test('Kordi Factory keeps its product identity after an assistant reply is persisted', () => {
  const html = renderToStaticMarkup(
    <AgentStudioConversation
      targetName="Kordi"
      creating={false}
      sessionId="session:agent-builder:test"
      detail={builderSession([{
        role: 'assistant',
        sender: 'Kordi',
        text: 'I updated the private draft.',
        timeLabel: '10:27',
        timestampMs: 2,
      }])}
      activeTurn={null}
      optimisticPrompt={null}
      opening={false}
      error={null}
      onSend={() => undefined}
      onStop={() => undefined}
    />,
  );

  assert.match(html, /Kordi Factory/);
  assert.match(html, /I updated the private draft/);
  assert.doesNotMatch(html, /My Kordi/);
});

test('Kordi Factory keeps a persisted cancelled turn visible', () => {
  const html = renderToStaticMarkup(
    <AgentStudioConversation
      targetName="Kordi"
      creating={false}
      sessionId="session:agent-builder:test"
      detail={builderSession([{
        role: 'assistant',
        sender: 'Kordi',
        text: '',
        timeLabel: '10:28',
        timestampMs: 3,
        cancelled: true,
      }])}
      activeTurn={null}
      optimisticPrompt={null}
      opening={false}
      error={null}
      onSend={() => undefined}
      onStop={() => undefined}
    />,
  );

  assert.match(html, /Kordi Factory/);
  assert.match(html, /Response stopped/);
  assert.match(html, /app-live-turn-cancelled/);
});

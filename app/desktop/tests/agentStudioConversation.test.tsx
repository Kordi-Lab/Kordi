import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentStudioConversation } from '../src/kordi-app/agents/AgentStudioConversation';
import type { DesktopChatSessionDetail } from '../src/kordi-app/types';

function builderSession(): DesktopChatSessionDetail {
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
    messageCount: 1,
    draft: false,
    contextWindowText: '1%',
    contextWindowStatus: { contextWindow: 100_000, autoCompaction: true },
    messages: [{
      role: 'user',
      text: 'Make the instructions more concise',
      timeLabel: '10:26',
      timestampMs: 1,
    }],
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
  assert.match(html, /ChatGPT account/);
  assert.match(html, /GPT Test/);
  assert.match(html, /Medium/);
  assert.match(html, /aria-label="Send to Kordi Factory"/);
  assert.doesNotMatch(html, /Agent Builder/);
  assert.doesNotMatch(html, /Attachments are not available/);
});

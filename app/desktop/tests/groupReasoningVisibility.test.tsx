import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const reasoning = 'Synthetic private reasoning';
for (const completed of [false, true]) {
  for (const owner of [true, false]) {
    test(`group reasoning is ${owner ? 'visible to its owner' : 'hidden from a peer'} while ${completed ? 'completed' : 'running'}`, () => {
      const turn: DesktopChatTurnSnapshot = {
        id: 'group-turn', sessionId: 'group-session', prompt: '', status: completed ? 'complete' : 'analyzing',
        message: '', assistantText: 'Public reply', thinkingText: reasoning, tools: [], completed, succeeded: completed,
      };
      const html = renderToStaticMarkup(createElement(MessageBubble, {
        msg: { id: 'group-reply', role: owner ? 'owned-agent' : 'external-agent', sender: 'Synthetic Agent', text: '', time: '12:00', turn },
      }));
      assert.equal(/synthetic private reasoning/i.test(html), owner);
      assert.match(html, /Public reply/);
    });
  }
}

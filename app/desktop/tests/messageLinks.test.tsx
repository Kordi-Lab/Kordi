import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageBubble, LiveChatTurnCard } from '../src/kordi-app/components/transcript';
import { SourceMessageQuote } from '../src/kordi-app/components/transcriptReplyAttribution';
import {
  MessageInlineContent,
} from '../src/kordi-app/components/messageInlineContent';
import {
  openExternalMessageLink,
  parseMessageInlineParts,
  safeExternalHttpHref,
  siteIconDescriptorForHref,
  siteIconRequestUrl,
} from '../src/kordi-app/components/messageLinks';
import { canonicalMentions } from '../src/features/canonical/readModel/mentionMapping';
import { mentionForCollaborationTarget } from '../src/features/chat/messageMentions';
import {
  clearRemoteAvatarImageCacheForTests,
  loadAvatarThroughNativeProxy,
} from '../src/kordi-app/components/remoteAvatarImage';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import { QueuedMessageBubble } from '../src/pages/chatsPage.queuedMessage';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

const issueUrl = 'https://github.com/Kordi-AI/Kordi/issues/865';

function installNativeWindow() {
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(target, 'window', {
    configurable: true,
    writable: true,
    value: { __TAURI_INTERNALS__: {} },
  });
  return () => {
    if (previous) Object.defineProperty(target, 'window', previous);
    else Reflect.deleteProperty(target, 'window');
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: `@MyKordi review ${issueUrl}.`,
    time: '16:42',
    mentions: [{ label: 'MyKordi', targetKind: 'agent' }],
    statusChips: ['sent'],
    ...overrides,
  };
}

test('plain message content tokenizes structured mentions and safe URLs without overlap', () => {
  const parts = parseMessageInlineParts(
    '@MyKordi read https://example.com/paper_(final)).',
    [{ label: 'MyKordi', targetKind: 'agent' }],
  );

  assert.equal(parts.filter((part) => part.type === 'mention').length, 1);
  assert.deepEqual(
    parts.filter((part) => part.type === 'link').map((part) => part.type === 'link' ? part.href : ''),
    ['https://example.com/paper_(final)'],
  );
  assert.equal(parts.map((part) => part.type === 'text' ? part.value : part.label).join(''), '@MyKordi read https://example.com/paper_(final)).');

  const urlMention = parseMessageInlineParts(
    'See https://example.com/@MyKordi/docs',
    [{ label: 'MyKordi', targetKind: 'agent' }],
  );
  assert.equal(urlMention.filter((part) => part.type === 'link').length, 1);
  assert.equal(urlMention.filter((part) => part.type === 'mention').length, 0);
});

test('plain message content renders known Blob Emoji shortcodes inline', () => {
  const parts = parseMessageInlineParts('hello :blob:blobwave: :blob:not-real:');
  const html = renderToStaticMarkup(createElement(MessageInlineContent, {
    text: 'hello :blob:blobwave: :blob:not-real:',
  }));

  assert.equal(parts.filter((part) => part.type === 'blobEmoji').length, 1);
  assert.match(html, /blobwave\.webp/);
  assert.match(html, /:blob:not-real:/);
});

test('plain message content emphasizes every textual mention alongside a structured target', () => {
  const parts = parseMessageInlineParts(
    '@AlexMorgansKordi, please ask @EthanParksKordi to reply. Email test@example.com.',
    [{ label: 'AlexMorgansKordi', targetKind: 'agent' }],
  );

  assert.deepEqual(
    parts
      .filter((part) => part.type === 'mention')
      .map((part) => part.type === 'mention' ? [part.label, part.targetKind] : []),
    [
      ['@AlexMorgansKordi', 'agent'],
      ['@EthanParksKordi', 'agent'],
    ],
  );
  assert.equal(
    parts.some((part) => part.type === 'mention' && part.label === '@example'),
    false,
  );
});

test('structured mentions preserve and highlight the complete display label', () => {
  const mentions = canonicalMentions([{
    label: 'MyKordi',
    displayLabel: 'My Kordi',
    targetKind: 'agent',
  }]);
  const parts = parseMessageInlineParts('@My Kordi hello', mentions);

  assert.deepEqual(
    parts.map((part) => part.type === 'text' ? part.value : part.label),
    ['@My Kordi', ' hello'],
  );
  assert.equal(parts[0]?.type, 'mention');
  assert.equal(parts[0]?.type === 'mention' ? parts[0].targetKind : null, 'agent');
});

test('legacy My Kordi messages highlight the complete built-in name without metadata', () => {
  const text = '@My Kordi check all my Kordi project worktrees.';
  const parts = parseMessageInlineParts(text);

  assert.deepEqual(
    parts.map((part) => part.type === 'text' ? part.value : part.label),
    ['@My Kordi', ' check all my Kordi project worktrees.'],
  );
  assert.equal(parts[0]?.type === 'mention' ? parts[0].targetKind : null, 'agent');
});

test('legacy structured aliases match multi-word labels case-insensitively', () => {
  const parts = parseMessageInlineParts('@project driver check this.', [{
    label: 'ProjectDriver',
    displayLabel: 'Project Driver',
    targetKind: 'agent',
  }]);

  assert.deepEqual(
    parts.map((part) => part.type === 'text' ? part.value : part.label),
    ['@project driver', ' check this.'],
  );
  assert.equal(parts[0]?.type === 'mention' ? parts[0].targetKind : null, 'agent');
});

test('identity ranges preserve Unicode multi-word mentions without text inference', () => {
  const displayText = "@ليان 🧭’s Kordi";
  const text = `Ask ${displayText} to review this.`;
  const startUtf16 = text.indexOf(displayText);
  const parts = parseMessageInlineParts(text, canonicalMentions([{
    label: 'LiansKordi',
    targetKind: 'agent',
    targetIdentityId: 'agent:cloud_agent_lian',
    startUtf16,
    lengthUtf16: displayText.length,
    displayText,
  }]));
  const mention = parts.find((part) => part.type === 'mention');

  assert.deepEqual(mention, {
    type: 'mention',
    label: displayText,
    targetKind: 'agent',
    targetIdentityId: 'agent:cloud_agent_lian',
    start: startUtf16,
  });
});

test('reply previews render the complete structured mention instead of the first word', () => {
  const displayText = "@Alex Smith’s Kordi";
  const html = renderToStaticMarkup(createElement(SourceMessageQuote, {
    sourceMessage: {
      messageId: 'msg_source',
      senderLabel: 'Alex',
      text: `${displayText} please review`,
      mentions: [{
        label: 'AlexSmithsKordi',
        targetKind: 'agent',
        targetIdentityId: 'agent:cloud_agent_alex',
        startUtf16: 0,
        lengthUtf16: displayText.length,
        displayText,
      }],
    },
    compactReplyPreview: true,
  }));

  assert.match(html, /data-mention-identity="agent:cloud_agent_alex"[^>]*aria-label="@Alex Smith’s Kordi, agent mention"[^>]*>@Alex Smith’s Kordi<\/span>/);
  assert.doesNotMatch(html, /<\/span> Smith/);
});

test('collaboration mention metadata keeps the complete display label', () => {
  const mention = mentionForCollaborationTarget({
    host: { id: 'cloud' } as never,
    peer: { nodeId: 'acct_alice', agentId: 'cloud-agent:acct_alice' } as never,
    label: 'AlicesKordi',
    displayLabel: "Alice's Kordi",
    targetKind: 'agent',
    requestText: 'hello',
  })[0];

  assert.equal(mention?.label, 'AlicesKordi');
  assert.equal(mention?.displayLabel, "Alice's Kordi");
  assert.equal(mention?.targetIdentityId, 'agent:cloud-agent:acct_alice');
});

test('shared inline renderer gives human and agent mentions distinct semantic colors', () => {
  const html = renderToStaticMarkup(createElement(MessageInlineContent, {
    text: '@EthanPark ask @EthanParksKordi',
    mentions: [{ label: 'EthanPark', targetKind: 'person' }],
  }));

  assert.match(html, /app-message-mention-person[^>]*data-mention-kind="person"[^>]*>@EthanPark<\/span>/);
  assert.match(html, /app-message-mention-agent[^>]*data-mention-kind="agent"[^>]*>@EthanParksKordi<\/span>/);
});

test('shared inline renderer announces structured @all as a human group mention', () => {
  const html = renderToStaticMarkup(createElement(MessageInlineContent, {
    text: '@all please review',
    mentions: [{
      label: 'all',
      targetKind: 'all',
      targetIdentityId: 'group:session:group:triad',
      startUtf16: 0,
      lengthUtf16: 4,
      displayText: '@all',
    }],
  }));

  assert.match(html, /app-message-mention-all[^>]*app-message-mention-person/);
  assert.match(html, /data-mention-kind="all"[^>]*aria-label="@all, all people in this group"/);
});

test('message URL validation leaves unsafe or credential-bearing schemes inert', () => {
  const text = 'javascript:alert(1) data:text/html,test https://user:secret@example.com/private';
  assert.equal(parseMessageInlineParts(text).some((part) => part.type === 'link'), false);
  assert.equal(safeExternalHttpHref('javascript:alert(1)'), null);
  assert.equal(safeExternalHttpHref('file:///tmp/report'), null);
  assert.equal(safeExternalHttpHref('https://user:secret@example.com/private'), null);
  assert.equal(safeExternalHttpHref('HTTPS://example.com/report'), 'HTTPS://example.com/report');
});

test('site icon lookup reveals only the normalized hostname', () => {
  const requestUrl = siteIconRequestUrl('http://Example.COM:8443/private/path?token=secret#notes');
  const firstDescriptor = siteIconDescriptorForHref('https://example.com/one?private=yes');
  const secondDescriptor = siteIconDescriptorForHref('http://EXAMPLE.com:8080/two#private');

  assert.equal(requestUrl, 'https://example.com/favicon.ico');
  assert.strictEqual(firstDescriptor, secondDescriptor, 'one hostname should reuse one favicon descriptor');
  assert.doesNotMatch(requestUrl ?? '', /8443|private|token|secret|notes/);
  assert.equal(siteIconRequestUrl('https://user:secret@example.com/private'), null);
  assert.equal(siteIconRequestUrl('data:image/png;base64,icon'), null);
});

test('shared inline renderer emits an accessible external link with a stable icon fallback', () => {
  const html = renderToStaticMarkup(createElement(MessageInlineContent, {
    text: `@MyKordi open ${issueUrl}`,
    mentions: [{ label: 'MyKordi', targetKind: 'agent' }],
  }));

  assert.match(html, /app-message-mention[^>]*>@MyKordi<\/span>/);
  assert.match(html, /data-external-message-link="true"/);
  assert.match(html, /href="https:\/\/github\.com\/Kordi-AI\/Kordi\/issues\/865"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.match(html, /data-site-icon-host="github\.com"/);
  assert.match(html, /data-site-icon-state="idle"/);
  assert.match(html, /<svg[^>]+aria-hidden="true"/);
  assert.doesNotMatch(html, /<img[^>]+src="https:\/\/github\.com/);
});

test('site icons reuse the native image cache and render cached or failed states without layout changes', async () => {
  const restoreWindow = installNativeWindow();
  const faviconUrl = siteIconRequestUrl(issueUrl);
  assert.ok(faviconUrl);
  clearRemoteAvatarImageCacheForTests();
  let calls = 0;

  try {
    const invoke = async <T,>(): Promise<T> => {
      calls += 1;
      return 'data:image/x-icon;base64,aWNvbg==' as T;
    };
    await loadAvatarThroughNativeProxy(faviconUrl, invoke);
    await loadAvatarThroughNativeProxy(faviconUrl, invoke);
    const readyHtml = renderToStaticMarkup(createElement(MessageInlineContent, { text: issueUrl }));

    assert.equal(calls, 1);
    assert.match(readyHtml, /data-site-icon-state="ready"/);
    assert.match(readyHtml, /<img[^>]+src="data:image\/x-icon;base64,aWNvbg=="/);

    clearRemoteAvatarImageCacheForTests();
    await assert.rejects(loadAvatarThroughNativeProxy(faviconUrl, async () => {
      throw new Error('missing icon');
    }));
    const failedHtml = renderToStaticMarkup(createElement(MessageInlineContent, { text: issueUrl }));
    assert.match(failedHtml, /data-site-icon-state="failed"/);
    assert.match(failedHtml, /<svg[^>]+aria-hidden="true"/);
    assert.doesNotMatch(failedHtml, /<img/);
  } finally {
    clearRemoteAvatarImageCacheForTests();
    restoreWindow();
  }
});

test('ordinary clicks route through the external opener and unsafe targets are rejected', () => {
  const opened: string[] = [];
  let prevented = 0;
  const event = {
    button: 0,
    defaultPrevented: false,
    preventDefault: () => { prevented += 1; },
  };

  assert.equal(openExternalMessageLink(event, issueUrl, (url) => opened.push(url)), true);
  assert.equal(openExternalMessageLink(event, 'javascript:alert(1)', (url) => opened.push(url)), false);
  assert.deepEqual(opened, [issueUrl]);
  assert.equal(prevented, 1);
});

test('every durable transcript density uses the shared link renderer', () => {
  const cases = [
    renderToStaticMarkup(createElement(MessageBubble, { msg: message() })),
    renderToStaticMarkup(createElement(MessageBubble, {
      msg: message({ role: 'person', sender: 'Peer', isOwnMessage: false }),
      densityMode: 'contact-compact',
    })),
    renderToStaticMarkup(createElement(MessageBubble, {
      msg: message({ role: 'person', sender: 'Group member', isOwnMessage: false }),
      densityMode: 'group-compact',
    })),
    renderToStaticMarkup(createElement(MessageBubble, {
      msg: message(),
      densityMode: 'agent-compact',
    })),
    renderToStaticMarkup(createElement(MessageBubble, {
      msg: message({
        role: 'owned-agent',
        sender: 'My Kordi',
        senderType: 'agent',
        isOwnMessage: false,
        text: `Review [issue #865](${issueUrl}).`,
        mentions: undefined,
      }),
    })),
    renderToStaticMarkup(createElement(MessageBubble, {
      msg: message({ role: 'system', sender: undefined, text: `Details: ${issueUrl}`, mentions: undefined }),
    })),
  ];

  for (const html of cases) {
    assert.match(html, /data-external-message-link="true"/);
    assert.match(html, /data-site-icon-host="github\.com"/);
  }
});

test('streaming replies and queued messages use the same transcript link treatment', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-link',
    sessionId: 'session-link',
    prompt: 'Find the issue',
    status: 'completed',
    message: 'Completed',
    assistantText: `Opened [issue #865](${issueUrl}).`,
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
  };
  const liveHtml = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn, historical: true }));
  const queuedHtml = renderToStaticMarkup(createElement(QueuedMessageBubble, {
    message: {
      id: 'queued-link',
      sessionId: 'session-link',
      scope: 'chat',
      text: `Open ${issueUrl}`,
      time: '16:43',
      attachments: [],
    },
    isCompressionActive: false,
  }));

  for (const html of [liveHtml, queuedHtml]) {
    assert.match(html, /data-external-message-link="true"/);
    assert.match(html, /data-site-icon-host="github\.com"/);
  }
});

test('chat links keep fixed icon geometry and immediate hover/focus feedback', () => {
  const css = readDesktopShellCss();

  assert.match(css, /\.app-message-link-site-icon\s*{[\s\S]*width:\s*14px;[\s\S]*height:\s*14px;[\s\S]*vertical-align:\s*-2px;/);
  assert.match(css, /\.app-markdown-link\s*{[\s\S]*transition:\s*color 80ms ease-out;/);
  assert.match(css, /\.app-markdown-link:hover\s*{[\s\S]*text-decoration-line:\s*underline;/);
  assert.match(css, /\.app-markdown-link:focus-visible\s*{[\s\S]*outline:\s*2px solid/);
});

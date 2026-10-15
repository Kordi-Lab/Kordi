import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { ForwardMessageSource } from '../src/features/chat/messageActionMetadata';
import {
  documentPreviewText,
  previewDocumentAttachment,
  setDocumentPreviewTitleFetchForTests,
} from '../src/features/documents/documentPreviewTitles';
import { notifyDocumentSyncEvents } from '../src/features/documents/documentSyncEvents';
import { rememberDocumentTitle, resetDocumentTitlesForTests, type DocumentTitleFetch } from '../src/features/documents/documentTitles';
import type { Message, MessageAttachment } from '../src/kordi-app/types';
import { MessageForwardDialog } from '../src/pages/MessageForwardDialog';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { SidebarPreviewText } from '../src/pages/workspaceSidebar.chatPrimitives';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';
import { baseSidebarProps, conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';

const markdown: MessageAttachment = { kind: 'file', name: 'Untitled 2.md', attachmentId: 'att_untitled_2', mimeType: 'text/markdown' };

function attachmentMessage(attachments: MessageAttachment[], text = ''): Message {
  return { id: 'msg_doc', role: 'person', sender: 'Alice', text, time: '14:54', attachments };
}

function mainChannel(message: Message) {
  return conversation({
    id: 'session:group:main',
    canonicalSessionId: 'session:group:main',
    name: 'Main',
    subtitle: '',
    unread: 0,
    participants: ['Me', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
    ],
    messages: [message],
  });
}

function sidebarMarkup(message: Message) {
  const chatConversations = [mainChannel(message)];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  return renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
    activeConvId: 'session:group:main',
  }) as never));
}

function previewLines(markup: string) {
  const space = /app-participant-space-row-preview[\s\S]*?<span class="min-w-0 truncate">([\s\S]*?)<\/span>\s*<\/div>/.exec(markup)?.[1] ?? '';
  const session = /app-participant-space-session-preview[^>]*>([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? '';
  return { space, session };
}

const neverFetch: DocumentTitleFetch = () => new Promise(() => undefined);

test.beforeEach(() => {
  resetDocumentTitlesForTests();
  setDocumentPreviewTitleFetchForTests(neverFetch);
});
test.afterEach(() => setDocumentPreviewTitleFetchForTests(null));

test('a preview swaps the file name it ends with for a title that says more', () => {
  assert.equal(documentPreviewText('Untitled 2.md', 'Untitled 2.md', 'Q4 plan'), 'Q4 plan');
  assert.equal(documentPreviewText('Lab agent · Untitled 2.md', 'Untitled 2.md', 'Q4 plan'), 'Lab agent · Q4 plan');
  assert.equal(documentPreviewText('Untitled 2.md', 'Untitled 2.md', 'Untitled 2'), 'Untitled 2.md');
  assert.equal(documentPreviewText('Untitled 2.md', 'Untitled 2.md', null), 'Untitled 2.md');
  assert.equal(documentPreviewText('Read this first', 'Untitled 2.md', 'Q4 plan'), 'Read this first');
});

test('only a single cloud Markdown or HTML attachment names a document', () => {
  assert.deepEqual(previewDocumentAttachment(attachmentMessage([markdown])), { attachmentId: 'att_untitled_2', name: 'Untitled 2.md' });
  assert.ok(previewDocumentAttachment(attachmentMessage([{ ...markdown, name: 'page.html', attachmentId: 'att_html' }])));
  assert.equal(previewDocumentAttachment(attachmentMessage([{ ...markdown, name: 'paper.pdf', attachmentId: 'att_pdf' }])), null);
  assert.equal(previewDocumentAttachment(attachmentMessage([{ ...markdown, attachmentId: null }])), null);
  assert.equal(previewDocumentAttachment(attachmentMessage([markdown, { ...markdown, attachmentId: 'att_other' }])), null);
});

test('sidebar group and channel previews show a renamed document after a rename event', () => {
  const message = attachmentMessage([markdown]);
  const before = previewLines(sidebarMarkup(message));
  assert.equal(before.space, 'Untitled 2.md');
  assert.equal(before.session, 'Untitled 2.md');

  notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: 'att_untitled_2', revision: 3, change: 'title', title: 'xixi xhiqueuqoe' } }]);
  const after = previewLines(sidebarMarkup(message));
  assert.equal(after.space, 'xixi xhiqueuqoe');
  assert.equal(after.session, 'xixi xhiqueuqoe');
});

test('sidebar previews keep the file name without a title, for text messages and for other files', () => {
  rememberDocumentTitle('att_pdf', 'Paper title');
  assert.equal(previewLines(sidebarMarkup(attachmentMessage([{ ...markdown, name: 'paper.pdf', attachmentId: 'att_pdf' }]))).session, 'paper.pdf');
  assert.equal(previewLines(sidebarMarkup(attachmentMessage([markdown]))).session, 'Untitled 2.md');

  rememberDocumentTitle('att_untitled_2', 'Q4 plan');
  assert.equal(previewLines(sidebarMarkup(attachmentMessage([markdown], 'Notes for Friday'))).session, 'Notes for Friday');
});

test('a rendered sidebar preview fetches a missing title once and re-renders', async () => {
  const asked: string[] = [];
  setDocumentPreviewTitleFetchForTests(async (attachmentId) => { asked.push(attachmentId); return { title: 'Launch notes' }; });
  const conversations = [mainChannel(attachmentMessage([markdown]))];
  await withJsdomRoot(async (mount) => {
    const root = await mount(createElement('div', null,
      createElement('span', { 'data-row': 'space' }, createElement(SidebarPreviewText, { text: 'Untitled 2.md', conversations })),
      createElement('span', { 'data-row': 'session' }, createElement(SidebarPreviewText, { text: 'Untitled 2.md', conversations }))));
    await waitForReactCondition(() => root.textContent === 'Launch notesLaunch notes', 'both previews show the fetched title');
    assert.deepEqual(asked, ['att_untitled_2'], 'one request per document');

    await act(async () => {
      notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: 'att_untitled_2', revision: 4, change: 'title', title: 'Launch notes v2' } }]);
    });
    assert.equal(root.querySelector('[data-row="session"]')?.textContent, 'Launch notes v2');
  });
});

test('previews of other files never fetch a title', async () => {
  const asked: string[] = [];
  setDocumentPreviewTitleFetchForTests(async (attachmentId) => { asked.push(attachmentId); return { title: 'Nope' }; });
  const conversations = [mainChannel(attachmentMessage([{ ...markdown, name: 'photo.png', kind: 'image', mimeType: 'image/png', attachmentId: 'att_png' }]))];
  await withJsdomRoot(async (mount) => {
    const root = await mount(createElement(SidebarPreviewText, { text: 'Photo', conversations }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(root.textContent, 'Photo');
    assert.deepEqual(asked, []);
  });
});

test('the forward sheet previews a renamed document under its title', () => {
  rememberDocumentTitle('att_untitled_2', 'Q4 plan');
  const source: ForwardMessageSource = {
    sourceSessionId: 'session:group:main',
    sourceMessageId: 'msg_doc',
    senderLabel: 'Alice',
    textPreview: 'Untitled 2.md',
    attachmentCount: 1,
    attachments: [markdown],
    attachmentOnly: true,
  };
  const markup = renderToStaticMarkup(createElement(MessageForwardDialog, { sources: [source], destinations: [], onClose: () => undefined, onForward: () => undefined }));
  assert.match(markup, /Alice: Q4 plan/);
});

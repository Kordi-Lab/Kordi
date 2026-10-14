import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { assembleRightDetailSlot } from '../src/app/assembleRightDetailSlot';
import type { RightDetailShellArgs } from '../src/app/kordiShellSlots.types';
import type { AttachmentItem } from '../src/features/chat/composerController.types';
import { EMPTY_CHAT_SELECTION_ID } from '../src/features/chat/draftSessions';
import { uploadComposerAttachments } from '../src/features/cloud/cloudComposerAttachments';
import {
  cachedCloudAttachmentLocalPath,
  clearCloudAttachmentLocalPathCache,
  persistCloudAttachmentPath,
  rememberUploadedAttachmentSource,
} from '../src/features/cloud/cloudAttachmentLocalPathCache';
import { ChatDocumentEntries } from '../src/features/documents/ChatDocumentEntries';
import { COMPANION_DOCUMENT_OPEN_EVENT, openAttachmentInCompanion, type CompanionDocument } from '../src/features/documents/companionDocument';
import {
  ADD_DOCUMENT_ACCEPT,
  ADD_DOCUMENT_FAILED,
  BLANK_DOCUMENT_BODY,
  addableDocumentContentType,
  chatDocumentArtifacts,
  chatDocumentAttachment,
  chatDocumentNames,
  nextUntitledDocumentName,
  sentChatDocument,
  withChatDocumentArtifacts,
} from '../src/features/documents/chatDocuments';
import { DocumentReaderHostContext, documentReaderHostForConversation, type DocumentReaderHost } from '../src/features/documents/documentReaderHost';
import type { Message, MessageAttachment, SessionArtifact } from '../src/kordi-app/types';
import { ArtifactInspector } from '../src/pages/ArtifactInspector';
import { ChatDetailPanel } from '../src/pages/ChatDetailPanel';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const STORED_PATH = '/tmp/kordi-attachments/Untitled-1.md';
// Where the upload persists its copy; sent messages point here, not at the stored file.
const CACHED_COPY_PATH = '/tmp/kordi-cloud-attachments/att_new/Untitled.md';
const account = { accountId: 'acct_example_alex', displayName: 'Alex Morgan', kordiId: '123456789', avatarUrl: null };
const conversation = { id: 'session:group:example', canonicalSessionId: 'session:group:example', canonicalParticipants: [] };

function attachmentMessage(id: string, attachment: Partial<MessageAttachment> & { name: string }): Message {
  return { id, role: 'user', isOwnMessage: true, text: '', time: '10:02', attachments: [{ kind: 'file', ...attachment }] };
}

function storedItem(file: File): AttachmentItem {
  return { id: `${file.name}-${STORED_PATH}`, name: file.name, path: STORED_PATH, localPath: STORED_PATH, kind: 'file', mimeType: file.type, sizeBytes: file.size };
}

function hostWith(addDocument?: DocumentReaderHost['addDocument']): DocumentReaderHost {
  return { viewer: null, sessionId: conversation.id, agentName: null, people: [], opensDocumentsInCompanion: true, addDocument };
}

function button(root: ParentNode, label: string) {
  const match = Array.from(root.querySelectorAll('button')).find((entry) => entry.textContent === label);
  assert.ok(match, `button ${label}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function artifactsPanel(host: DocumentReaderHost | null, artifacts: SessionArtifact[] = [], messages: Message[] = []) {
  const panel = createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'artifacts',
    activeConv: { ...conversation, name: 'Example', type: 'person', subtitle: '', unread: 0, collaborationSources: ['Cloud'], trust: 'Cloud', directness: 'Group chat', participants: ['Me'], messages },
    activeConvHasSubtitle: false,
    activeConversationUsesCollaboration: true,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    artifacts,
    activeArtifactId: null,
    onSelectArtifact: () => {},
  });
  return host ? createElement(DocumentReaderHostContext.Provider, { value: host }, panel) : panel;
}

test('a new document is Untitled.md, then numbered past the names the chat already has', () => {
  assert.equal(nextUntitledDocumentName([]), 'Untitled.md');
  assert.equal(nextUntitledDocumentName(['notes.md']), 'Untitled.md');
  assert.equal(nextUntitledDocumentName(['Untitled.md']), 'Untitled 2.md');
  assert.equal(nextUntitledDocumentName(['untitled.md', ' Untitled 2.md ', 'Untitled 4.md']), 'Untitled 3.md');
  const names = chatDocumentNames(
    [{ id: 'a', path: 'notes/Untitled.md', name: '', kind: 'document', summary: '' }],
    [attachmentMessage('m1', { name: 'Untitled 2.md', attachmentId: 'att_2' })],
  );
  assert.deepEqual(names, ['Untitled.md', 'Untitled 2.md']);
  assert.equal(nextUntitledDocumentName(names), 'Untitled 3.md');
  assert.equal(BLANK_DOCUMENT_BODY.trim(), '', 'a new document has an empty body');
});

test('Add file takes Markdown and HTML only and types them for the server', async () => {
  assert.equal(ADD_DOCUMENT_ACCEPT, '.md,.markdown,.html,.htm');
  assert.equal(addableDocumentContentType('plan.md'), 'text/markdown');
  assert.equal(addableDocumentContentType('Plan.MARKDOWN'), 'text/markdown');
  assert.equal(addableDocumentContentType('page.html'), 'text/html');
  assert.equal(addableDocumentContentType('page.htm'), 'text/html');
  for (const name of ['notes.txt', 'report.pdf', 'archive.md.zip', 'README']) assert.equal(addableDocumentContentType(name), null, name);

  const stored: File[] = [];
  const store = async (file: File) => { stored.push(file); return storedItem(file); };
  const item = await chatDocumentAttachment(new File(['# Plan'], 'plan.md'), store);
  assert.equal(stored[0].type, 'text/markdown', 'an untyped Markdown file is typed before it is stored');
  assert.equal(await stored[0].text(), '# Plan');
  assert.equal(item.mimeType, 'text/markdown');
  await chatDocumentAttachment(new File(['<p>Hi</p>'], 'page.htm', { type: 'text/html' }), store);
  assert.equal(stored[1].type, 'text/html');
  await assert.rejects(chatDocumentAttachment(new File(['x'], 'notes.txt', { type: 'text/plain' }), store), new RegExp(ADD_DOCUMENT_FAILED));
  assert.equal(stored.length, 2, 'a file that is not a document is never stored');
});

test('the entries are absent where an attachment cannot be sent', () => {
  const send = () => {};
  const input = { conversation, contacts: [], sendAttachmentMessage: send };
  assert.equal(documentReaderHostForConversation({ ...input, account, isNativeShell: true }).addDocument, send);
  assert.equal(documentReaderHostForConversation({ ...input, account: null, isNativeShell: true }).addDocument, undefined, 'signed out');
  assert.equal(documentReaderHostForConversation({ ...input, account, isNativeShell: false }).addDocument, undefined, 'not the desktop app');
  assert.equal(documentReaderHostForConversation({ ...input, account, isNativeShell: true, sendAttachmentMessage: undefined }).addDocument, undefined, 'no attachment send');

  const without = renderToStaticMarkup(artifactsPanel(hostWith()));
  assert.doesNotMatch(without, /New document|Add file|data-chat-document-entries/);
  assert.match(without, /No generated code or docs in this chat yet\./);
  assert.doesNotMatch(renderToStaticMarkup(artifactsPanel(null)), /New document|Add file/, 'no reader host, as in the agent companion page');

  const artifacts: SessionArtifact[] = [{ id: 'notes/plan.md', path: 'notes/plan.md', name: 'plan.md', kind: 'document', category: 'artifact', summary: 'Created' }];
  for (const markup of [renderToStaticMarkup(artifactsPanel(hostWith(send))), renderToStaticMarkup(artifactsPanel(hostWith(send), artifacts))]) {
    assert.match(markup, />New document</);
    assert.match(markup, />Add file</);
    assert.match(markup, /accept="\.md,\.markdown,\.html,\.htm"/);
  }
});

test('the chat detail slot adds a document through the composer send as an attachment-only message', () => {
  const calls: unknown[][] = [];
  const slotHost = (overrides: Partial<RightDetailShellArgs>) => {
    const slot = assembleRightDetailSlot({
      isNativeShell: true,
      activeNav: 'chats',
      activeDetailTab: 'artifacts',
      activeChatArtifacts: [],
      activeConv: { ...conversation, name: 'Example', type: 'person', subtitle: '', unread: 0, collaborationSources: ['Cloud'], trust: 'Cloud', participants: ['Me'], messages: [] },
      activeConversationUsesCollaboration: true,
      activeProjectSession: { id: 'session:project:one' },
      cloudSession: { account },
      handleSendChatMessage: (...args: unknown[]) => { calls.push(args); },
      ...overrides,
    } as unknown as RightDetailShellArgs);
    return (slot.props as { children: { props: { value: DocumentReaderHost } } }).children.props.value;
  };

  const item = storedItem(new File(['\n'], 'Untitled.md', { type: 'text/markdown' }));
  void slotHost({}).addDocument?.(item);
  assert.deepEqual(calls, [['', undefined, undefined, [item]]]);
  assert.equal(slotHost({ activeConversationUsesCollaboration: false }).addDocument, undefined, 'a local agent session');
  assert.equal(slotHost({ activeConv: { id: EMPTY_CHAT_SELECTION_ID } as RightDetailShellArgs['activeConv'] }).addDocument, undefined, 'no chat selected');
  assert.equal(slotHost({ cloudSession: { account: null } as RightDetailShellArgs['cloudSession'] }).addDocument, undefined, 'signed out');
});

test('documents sent in the chat are listed once, and the sent copy of a stored file is found by its path', () => {
  const messages = [
    attachmentMessage('m1', { name: 'plan.md', attachmentId: 'att_plan' }),
    attachmentMessage('m2', { name: 'photo.png', kind: 'image', attachmentId: 'att_photo' }),
    attachmentMessage('m3', { name: 'draft.md', localPath: '/tmp/draft.md' }),
    attachmentMessage('m4', { name: 'page.html', attachmentId: 'att_page', localPath: STORED_PATH }),
  ];
  assert.deepEqual(chatDocumentArtifacts(messages).map((artifact) => [artifact.id, artifact.name, artifact.attachmentId]), [
    ['attachment:att_page', 'page.html', 'att_page'],
    ['attachment:att_plan', 'plan.md', 'att_plan'],
  ]);
  const listed: SessionArtifact[] = [{ id: 'artifact_1', path: 'out/plan.md', name: 'plan.md', kind: 'file', category: 'artifact', summary: '', attachmentId: 'att_plan' }];
  assert.deepEqual(withChatDocumentArtifacts(listed, messages).map((artifact) => artifact.id), ['attachment:att_page', 'artifact_1']);
  assert.equal(withChatDocumentArtifacts(listed, []), listed);

  assert.equal(sentChatDocument(messages, STORED_PATH, () => null)?.attachmentId, 'att_page');
  assert.equal(sentChatDocument(messages, '/tmp/draft.md', () => null), null, 'not uploaded yet');
  assert.equal(sentChatDocument(messages, '/tmp/plan.md', (path) => (path === '/tmp/plan.md' ? 'att_plan' : null))?.attachmentId, 'att_plan', 'found by the id its upload got');
});

test('New document sends a blank Markdown file through the chat attachment send, then opens the sent copy', async () => {
  await withJsdomRoot(async (mount) => {
    const stored: File[] = [];
    const sent: AttachmentItem[] = [];
    const opened: MessageAttachment[] = [];
    const artifacts: SessionArtifact[] = [{ id: 'notes/Untitled.md', path: 'notes/Untitled.md', name: 'Untitled.md', kind: 'document', category: 'artifact', summary: 'Created' }];
    const host = hostWith((attachment) => { sent.push(attachment); rememberUploadedAttachmentSource(attachment.path, 'att_new'); });
    const entries = (messages: Message[]) => createElement(DocumentReaderHostContext.Provider, { value: host },
      createElement(ChatDocumentEntries, {
        conversationId: conversation.id,
        messages,
        artifacts,
        store: async (file: File) => { stored.push(file); return storedItem(file); },
        open: (attachment: MessageAttachment) => { opened.push(attachment); },
      }));

    const root = await mount(entries([]));
    await click(button(root, 'New document'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, 'Untitled 2.md', 'the listed Untitled.md is taken');
    assert.equal(stored[0].type, 'text/markdown');
    assert.equal(await stored[0].text(), BLANK_DOCUMENT_BODY);
    assert.deepEqual(sent.map((attachment) => [attachment.name, attachment.path, attachment.mimeType]), [['Untitled 2.md', STORED_PATH, 'text/markdown']]);
    assert.equal(opened.length, 0, 'nothing opens before the chat has the document');
    assert.equal(button(root, 'New document').disabled, true);
    assert.equal(button(root, 'Add file').disabled, true);

    // The optimistic message has no cloud id yet; the delivered one does.
    await mount(entries([attachmentMessage('m1', { name: 'Untitled 2.md', localPath: STORED_PATH })]));
    assert.equal(opened.length, 0);
    await mount(entries([attachmentMessage('m1', { name: 'Untitled 2.md', localPath: CACHED_COPY_PATH, attachmentId: 'att_new' })]));
    assert.deepEqual(opened.map((attachment) => [attachment.name, attachment.attachmentId]), [['Untitled 2.md', 'att_new']]);
    assert.equal(button(root, 'New document').disabled, false);
    assert.equal(root.querySelector('[role="alert"]'), null);
  });
});

test('Add file sends the picked document the same way, and a failed send says so', async () => {
  await withJsdomRoot(async (mount) => {
    const sent: AttachmentItem[] = [];
    let fail = false;
    const host = hostWith(async (attachment) => {
      if (fail) throw new Error('offline');
      sent.push(attachment);
    });
    const root = await mount(createElement(DocumentReaderHostContext.Provider, { value: host },
      createElement(ChatDocumentEntries, {
        conversationId: conversation.id,
        messages: [],
        artifacts: [],
        store: async (file: File) => storedItem(file),
        open: () => {},
        timeoutMs: 30,
      })));
    const input = root.querySelector('input[type="file"]') as HTMLInputElement;
    const pick = async (file: File) => {
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      await act(async () => {
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    await pick(new File(['<p>Hi</p>'], 'page.html', { type: 'text/html' }));
    assert.deepEqual(sent.map((attachment) => [attachment.name, attachment.mimeType]), [['page.html', 'text/html']]);
    // The chat never shows the document: the entry stops waiting and reports it.
    await waitForReactCondition(() => root.querySelector('[role="alert"]')?.textContent === ADD_DOCUMENT_FAILED, 'a document that never arrives is reported');
    assert.equal(button(root, 'Add file').disabled, false);

    fail = true;
    await pick(new File(['# Plan'], 'plan.md'));
    assert.equal(sent.length, 1);
    assert.equal(root.querySelector('[role="alert"]')?.textContent, 'Could not add the document.');

    fail = false;
    await pick(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    assert.equal(sent.length, 1, 'a file that is not a document is not sent');
    assert.equal(root.querySelector('[role="alert"]')?.textContent, 'Could not add the document.');
  });
});

test('the upload records the stored file it sent, though the message points at the cached copy', async () => {
  clearCloudAttachmentLocalPathCache();
  const [uploaded] = await uploadComposerAttachments({
    token: 'kordi_cs_example',
    client: {} as never,
    attachments: [storedItem(new File([BLANK_DOCUMENT_BODY], 'Untitled.md', { type: 'text/markdown' }))],
    useNativeUpload: true,
    nativeUpload: async () => ({ attachmentId: 'att_new', objectKey: 'attachments/acct/att_new', sizeBytes: 1, contentType: 'text/markdown', sha256Hex: 'a'.repeat(64), finalizedAt: '2026-10-14T00:00:00Z' }),
    persistAttachmentPath: (attachmentId, name, path) => persistCloudAttachmentPath(attachmentId, name, path, async () => CACHED_COPY_PATH),
  });
  assert.equal(uploaded.attachmentId, 'att_new');
  // The path the old match looked for is gone from both the message and the cache.
  assert.equal(cachedCloudAttachmentLocalPath('att_new'), CACHED_COPY_PATH);
  const delivered = [attachmentMessage('m1', { name: 'Untitled.md', attachmentId: 'att_new', localPath: CACHED_COPY_PATH })];
  assert.equal(sentChatDocument(delivered, STORED_PATH)?.attachmentId, 'att_new');
  clearCloudAttachmentLocalPathCache();
});

for (const chat of [
  // A group send goes through the outbox and its message carries the cached copy.
  { kind: 'group', delivered: { localPath: CACHED_COPY_PATH } },
  // A direct send merges the server message, which may carry no local path at all.
  { kind: 'direct', delivered: { localPath: null } },
] as const) {
  test(`New document opens the editor in a ${chat.kind} chat as soon as the uploaded copy is in the chat`, async () => {
    clearCloudAttachmentLocalPathCache();
    await withJsdomRoot(async (mount) => {
      const opened: CompanionDocument[] = [];
      const listen = (event: Event) => { opened.push((event as CustomEvent<CompanionDocument>).detail); event.preventDefault(); };
      window.addEventListener(COMPANION_DOCUMENT_OPEN_EVENT, listen);
      let finishSend: () => void = () => {};
      // The send resolves only after delivery and sync, later than the message shows up.
      const host = hostWith((attachment) => new Promise<void>((resolve) => {
        rememberUploadedAttachmentSource(attachment.path, 'att_new');
        finishSend = resolve;
      }));
      const entries = (messages: Message[]) => createElement(DocumentReaderHostContext.Provider, { value: host },
        createElement(ChatDocumentEntries, { conversationId: conversation.id, messages, artifacts: [], store: async (file: File) => storedItem(file), open: openAttachmentInCompanion }));

      const root = await mount(entries([]));
      await click(button(root, 'New document'));
      await mount(entries([attachmentMessage('m1', { name: 'Untitled.md', localPath: STORED_PATH })]));
      assert.equal(opened.length, 0, 'the optimistic copy has no cloud id yet');
      await mount(entries([attachmentMessage('m1', { name: 'Untitled.md', attachmentId: 'att_new', ...chat.delivered })]));
      assert.deepEqual(opened.map((document) => [document.artifact.id, document.artifact.attachmentId]), [['attachment:att_new', 'att_new']]);

      await act(async () => { finishSend(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.equal(opened.length, 1, 'opened once');
      assert.equal(root.querySelector('[role="alert"]'), null);
      assert.equal(button(root, 'New document').disabled, false);
      window.removeEventListener(COMPANION_DOCUMENT_OPEN_EVENT, listen);
    });
    clearCloudAttachmentLocalPathCache();
  });
}

test('the listed Untitled.md row opens the same editor tab as New document', async () => {
  await withJsdomRoot(async (mount) => {
    const opened: CompanionDocument[] = [];
    const listen = (event: Event) => { opened.push((event as CustomEvent<CompanionDocument>).detail); event.preventDefault(); };
    window.addEventListener(COMPANION_DOCUMENT_OPEN_EVENT, listen);
    const delivered = attachmentMessage('m1', { name: 'Untitled.md', attachmentId: 'att_new', localPath: CACHED_COPY_PATH });
    const root = await mount(createElement(DocumentReaderHostContext.Provider, { value: hostWith() },
      createElement(ArtifactInspector, {
        isNativeShell: false,
        artifacts: withChatDocumentArtifacts([], [delivered]),
        activeArtifactId: null,
        onSelectArtifact: () => {},
        emptyMessage: 'No generated code or docs in this chat yet.',
      })));
    const row = root.querySelector('[data-artifact-file-row="true"]') as HTMLElement;
    assert.match(row.textContent ?? '', /Untitled\.md/);
    await click(row);
    const [attachment] = delivered.attachments ?? [];
    assert.ok(attachment);
    openAttachmentInCompanion(attachment);
    assert.deepEqual(opened.map((document) => [document.artifact.id, document.artifact.attachmentId]), [
      ['attachment:att_new', 'att_new'],
      ['attachment:att_new', 'att_new'],
    ], 'the row and the transcript open one tab');
    window.removeEventListener(COMPANION_DOCUMENT_OPEN_EVENT, listen);
  });
});

test('the Artifacts tab shows the entries and the list, with nothing under the list', async () => {
  const delivered = attachmentMessage('m1', { name: 'Untitled.md', attachmentId: 'att_new', localPath: CACHED_COPY_PATH });
  await withJsdomRoot(async (mount) => {
    const root = await mount(artifactsPanel(hostWith(() => {}), [], [delivered]));
    const inspector = root.querySelector('[data-artifact-inspector="true"]');
    assert.ok(inspector);
    assert.deepEqual(Array.from(inspector.children).map((child) => child.getAttribute('data-artifact-file-list')), ['true'], 'no preview or document section under the list');
    const list = inspector.children[0];
    // The rows bleed 8px past the list on each side; the list must not scroll sideways for that.
    assert.match(list.className, /\boverflow-x-hidden\b/);
    assert.equal(list.querySelectorAll('[data-artifact-file-row="true"]').length, 1);
  });
});

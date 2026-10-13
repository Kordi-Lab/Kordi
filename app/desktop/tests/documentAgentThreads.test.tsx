import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import { DocumentThread, type DocumentMentionOption, type DocumentThreadActions } from '../src/features/documents/DocumentComments';
import { advanceAgentThreads, AGENT_EDIT_WINDOW_MS, documentMentionOptions, EMPTY_AGENT_THREADS } from '../src/features/documents/documentAgentThreads';
import { DocumentReader } from '../src/features/documents/DocumentReader';
import { DocumentReaderHostContext, documentReaderHostForConversation, type DocumentReaderHost } from '../src/features/documents/documentReaderHost';
import { commentThreadsForBlock } from '../src/features/documents/documentReaderModel';
import type { DocumentComment, DocumentResponse } from '../src/features/documents/documentShareTypes';
import { notifyDocumentSyncEvents } from '../src/features/documents/documentSyncEvents';
import { agentReply, agentThreadComments, comment, createMemoryDocumentApi, sampleDocument, systemReply } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const OPTIONS: DocumentMentionOption[] = [{ name: 'Lab agent', kind: 'agent' }, { name: 'Theo', kind: 'person' }];

const host: DocumentReaderHost = {
  viewer: { accountId: 'acct_example_alex', displayName: 'Alex Morgan', kordiId: '123456789', avatarUrl: null },
  sessionId: 'session_example',
  agentName: 'Lab agent',
  people: ['Theo'],
  agents: [{ name: 'Field agent', mine: false }, { name: 'Lab agent', mine: true }],
};

function recordedActions() {
  const replies: { rootId: string; body: string }[] = [];
  const deleted: string[] = [];
  const actions: DocumentThreadActions = {
    onReply: async (rootId, body) => { replies.push({ rootId, body }); return true; },
    onEdit: async () => true,
    onDelete: (commentId) => { deleted.push(commentId); },
    onResolve: () => undefined,
  };
  return { actions, replies, deleted };
}

function threadElement(comments: DocumentComment[], blockId: string, props: Partial<Parameters<typeof DocumentThread>[0]> = {}) {
  const [thread] = commentThreadsForBlock(comments, blockId);
  return createElement(DocumentThread, {
    thread,
    agentName: 'Lab agent',
    mentionOptions: OPTIONS,
    viewerIsOwner: false,
    canReply: true,
    shareUrl: null,
    actions: recordedActions().actions,
    ...props,
  });
}

function buttonLabels(root: ParentNode) {
  return Array.from(root.querySelectorAll('button')).map((entry) => entry.getAttribute('aria-label') ?? entry.textContent?.trim() ?? '');
}

function button(root: ParentNode, label: string) {
  const match = Array.from(root.querySelectorAll('button')).find((entry) => (
    entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label
  ));
  assert.ok(match, `button "${label}" is rendered`);
  return match as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mention(status: 'queued' | 'running' | 'completed' | 'failed' | null | undefined, overrides: Partial<DocumentComment> = {}) {
  return comment({
    commentId: 'doccmt_ask',
    blockId: 'b3',
    body: '@Lab agent what does this mean?',
    mentionsAgent: true,
    mine: true,
    ...(status === undefined ? {} : { agentRun: status ? { status } : null }),
    ...overrides,
  });
}

const answer = () => agentReply({ commentId: 'doccmt_answer', blockId: 'b3', parentCommentId: 'doccmt_ask', body: 'It means no prior study.' });

test('an agent reply shows the agent avatar, its name, and the Agent tag, without Edit', async () => {
  await withJsdomRoot(async (mount) => {
    const { actions, deleted } = recordedActions();
    const root = await mount(threadElement([mention('completed'), answer()], 'b3', { actions }));
    const reply = root.querySelector('#doccmt_answer') as HTMLElement;
    assert.equal(reply.querySelector('.app-document-agent-tag')?.textContent, 'Agent');
    assert.match(reply.querySelector('.app-document-comment-name')?.textContent ?? '', /^Lab agentAgent/);
    assert.equal(Boolean(reply.querySelector('.app-document-avatar-small')), true);
    assert.equal(root.querySelectorAll('.app-document-agent-tag').length, 1, 'people carry no tag');
    assert.match(reply.textContent ?? '', /It means no prior study\./);

    // The requester may delete the answer; there is nothing to edit.
    await click(button(reply, 'More'));
    assert.deepEqual(buttonLabels(reply.querySelector('[role="menu"]') as HTMLElement), ['Delete comment']);
    await click(button(reply, 'Delete comment'));
    assert.deepEqual(deleted, ['doccmt_answer']);
  });
});

test('an agent reply can be deleted by the owner or the requester only', async () => {
  await withJsdomRoot(async (mount, reactRoot) => {
    const asked = mention('completed', { mine: false });
    const root = await mount(threadElement([asked, answer()], 'b3'));
    assert.equal(Boolean(root.querySelector('#doccmt_answer [aria-label="More"]')), false, 'another member has no menu');
    await act(async () => { reactRoot.render(threadElement([asked, answer()], 'b3', { viewerIsOwner: true })); });
    assert.equal(Boolean(root.querySelector('#doccmt_answer [aria-label="More"]')), true, 'the owner may delete');
  });
});

test('a system reply is one muted line without an avatar', async () => {
  await withJsdomRoot(async (mount) => {
    const notice = systemReply({ commentId: 'doccmt_notice', blockId: 'b3', parentCommentId: 'doccmt_ask', body: 'Lab agent could not answer.' });
    const root = await mount(threadElement([mention(null), notice], 'b3'));
    const line = root.querySelector('#doccmt_notice') as HTMLElement;
    assert.equal(line.className, 'app-document-comment-system');
    assert.equal(line.textContent, 'Lab agent could not answer.');
    assert.equal(line.children.length, 0, 'no avatar, no header, no menu');
  });
});

test('the working line follows the run status: queued and running show it, completed does not', async () => {
  await withJsdomRoot(async (mount, reactRoot) => {
    const root = await mount(threadElement([mention('queued')], 'b3'));
    const working = () => root.querySelector('#doccmt_ask .app-document-agent-working')?.textContent ?? null;
    assert.equal(working(), 'Lab agent is working');
    await act(async () => { reactRoot.render(threadElement([mention('running')], 'b3')); });
    assert.equal(working(), 'Lab agent is working');

    // The refresh that completes the run brings the reply in the same render: no line, no gap.
    const asked = root.querySelector('#doccmt_ask');
    await act(async () => { reactRoot.render(threadElement([mention('completed'), answer()], 'b3')); });
    assert.equal(working(), null);
    assert.equal(root.querySelector('#doccmt_ask') === asked, true, 'the comment keeps its node (keyed by id)');
    assert.equal(Boolean(root.querySelector('#doccmt_answer')), true);

    // A completed run with no reply yet, and a comment that never had a run, show nothing.
    await act(async () => { reactRoot.render(threadElement([mention('completed')], 'b3')); });
    assert.equal(working(), null);
    await act(async () => { reactRoot.render(threadElement([mention(null)], 'b3')); });
    assert.equal(working(), null);
  });
});

test('the working line names the mentioned agent and sits under the comment that asked', async () => {
  await withJsdomRoot(async (mount) => {
    const options: DocumentMentionOption[] = [...OPTIONS, { name: 'Field agent', kind: 'agent' }];
    const comments = [
      mention('running', { body: '@Field agent check the table' }),
      comment({ commentId: 'doccmt_later', blockId: 'b3', parentCommentId: 'doccmt_ask', body: 'Thanks', createdAt: '2026-10-09T10:40:00Z' }),
    ];
    const root = await mount(threadElement(comments, 'b3', { mentionOptions: options }));
    assert.equal(root.querySelector('#doccmt_ask .app-document-agent-working')?.textContent, 'Field agent is working');
    assert.equal(root.querySelectorAll('.app-document-agent-working').length, 1);
  });
});

test('a failed run shows Could not answer with Retry, which posts the same body again', async () => {
  await withJsdomRoot(async (mount, reactRoot) => {
    const { actions, replies } = recordedActions();
    const root = await mount(threadElement([mention('failed')], 'b3', { actions }));
    const failed = root.querySelector('#doccmt_ask .app-document-agent-failed') as HTMLElement;
    assert.match(failed.textContent ?? '', /^Could not answer/);
    assert.equal(root.querySelectorAll('.app-document-agent-working').length, 0);
    await click(button(failed, 'Retry'));
    assert.deepEqual(replies, [{ rootId: 'doccmt_ask', body: '@Lab agent what does this mean?' }]);

    // The retry is a new reply with its own run; the failed line gives way to it.
    const retry = mention('queued', { commentId: 'doccmt_retry', parentCommentId: 'doccmt_ask', createdAt: '2026-10-09T10:50:00Z' });
    await act(async () => { reactRoot.render(threadElement([mention('failed'), retry], 'b3', { actions })); });
    assert.equal(root.querySelectorAll('.app-document-agent-failed').length, 0);
    assert.equal(root.querySelector('#doccmt_retry .app-document-agent-working')?.textContent, 'Lab agent is working');

    // A reader who cannot reply sees the state without the button.
    await act(async () => { reactRoot.render(threadElement([mention('failed')], 'b3', { canReply: false })); });
    assert.equal(root.querySelector('.app-document-agent-failed')?.textContent, 'Could not answer');
  });
});

test('without run statuses the old rule applies: the newest comment asks the agent', async () => {
  await withJsdomRoot(async (mount, reactRoot) => {
    const root = await mount(threadElement([mention(undefined)], 'b3'));
    assert.equal(root.querySelector('.app-document-agent-working')?.textContent, 'Lab agent is working');

    const reply = comment({ commentId: 'doccmt_reply', blockId: 'b3', parentCommentId: 'doccmt_ask', body: 'Answered in chat.', createdAt: '2026-10-09T10:40:00Z' });
    await act(async () => { reactRoot.render(threadElement([mention(undefined), reply], 'b3')); });
    assert.equal(root.querySelectorAll('.app-document-agent-working').length, 0, 'a reply ends the wait');

    // The rule never overrides data: a null run on the newest comment shows nothing.
    await act(async () => { reactRoot.render(threadElement([mention(null)], 'b3')); });
    assert.equal(root.querySelectorAll('.app-document-agent-working').length, 0);
  });
});

test('Ask <Agent> to edit appears only with edit rights under an agent reply, and prefixes the reply', async () => {
  await withJsdomRoot(async (mount, reactRoot) => {
    const { actions, replies } = recordedActions();
    const answered = [mention('completed'), answer()];
    const root = await mount(threadElement(answered, 'b3', { actions }));
    assert.equal(buttonLabels(root).includes('Ask Lab agent to edit'), false, 'no edit rights, no offer');
    await act(async () => { reactRoot.render(threadElement([mention('running')], 'b3', { actions, canAskEdit: true })); });
    assert.equal(buttonLabels(root).includes('Ask Lab agent to edit'), false, 'no agent reply, no offer');

    await act(async () => { reactRoot.render(threadElement(answered, 'b3', { actions, canAskEdit: true })); });
    const offer = button(root, 'Ask Lab agent to edit');
    const input = root.querySelector('.app-document-composer input') as HTMLInputElement;
    await click(offer);
    assert.equal(input.value, '@Lab agent ');
    assert.equal(globalThis.document.activeElement === input, true, 'the field takes focus');
    await click(offer);
    assert.equal(input.value, '@Lab agent ', 'the mention is added once');
    await click(button(root, 'Post'));
    assert.deepEqual(replies, [{ rootId: 'doccmt_ask', body: '@Lab agent ' }]);
  });
});

test('the picker lists own agents first, then shared agents, then people', () => {
  const names = (options: { name: string; kind: string }[]) => options.map((option) => `${option.kind}:${option.name}`);
  assert.deepEqual(
    names(documentMentionOptions({ agentName: 'Lab agent', agents: host.agents, people: ['Theo'], isPublic: false })),
    ['agent:Lab agent', 'agent:Field agent', 'person:Theo'],
  );
  assert.deepEqual(
    names(documentMentionOptions({ agentName: 'Desk agent', agents: host.agents, people: [], isPublic: false })),
    ['agent:Lab agent', 'agent:Desk agent', 'agent:Field agent'],
    'a document agent outside the session list follows the own agents',
  );
  assert.deepEqual(names(documentMentionOptions({ agentName: 'Lab agent', people: ['Theo'], isPublic: false })), ['agent:Lab agent', 'person:Theo']);
  assert.deepEqual(names(documentMentionOptions({ agentName: 'Lab agent', agents: host.agents, people: ['Theo'], isPublic: true })), ['agent:Lab agent']);
  assert.deepEqual(names(documentMentionOptions({ agentName: null, agents: host.agents, people: ['Theo'], isPublic: true })), []);
});

test('the reader host lists the session agents and marks the ones the signed-in account owns', () => {
  const participant = (id: string, name: string, kind: string, role: string, ownerIdentityId: string | null = null) => ({ id, name, kind, role, ownerIdentityId });
  const built = documentReaderHostForConversation({
    account: { accountId: 'acct_example_alex', displayName: 'Alex Morgan' } as Parameters<typeof documentReaderHostForConversation>[0]['account'],
    conversation: {
      id: 'session_example',
      canonicalParticipants: [
        participant('identity_alex', 'Me', 'human', 'self'),
        participant('identity_priya', 'Priya', 'human', 'member'),
        participant('identity_field', 'Field agent', 'agent', 'agent', 'identity_priya'),
        participant('identity_lab', 'Lab agent', 'agent', 'agent', 'identity_alex'),
        participant('identity_desk', 'Desk agent', 'agent', 'agent', 'acct_example_alex'),
        participant('identity_own', 'Own agent', 'agent', 'owned-agent'),
      ],
    },
    contacts: [],
    isNativeShell: false,
  });
  assert.deepEqual(built.agents, [
    { name: 'Field agent', mine: false },
    { name: 'Lab agent', mine: true },
    { name: 'Desk agent', mine: true },
    { name: 'Own agent', mine: true },
  ]);
  assert.deepEqual(built.people, ['Priya']);
});

test('a content update during a run marks the thread with the editing agent', () => {
  const start = advanceAgentThreads({ ...EMPTY_AGENT_THREADS, revision: 3 }, { comments: [mention('running')] }, 1_000);
  assert.deepEqual(start.edits, {});

  const during = advanceAgentThreads(start, { comments: [mention('running')], revision: 4, updatedByAgentName: 'Lab agent' }, 2_000);
  assert.deepEqual(during.edits, { doccmt_ask: 'Lab agent' });
  assert.equal(during.revision, 4);

  // The reply can land first; the content event that follows shortly still belongs to the run.
  const done = advanceAgentThreads(start, { comments: [mention('completed'), answer()] }, 2_000);
  const after = advanceAgentThreads(done, { comments: [mention('completed'), answer()], revision: 4, updatedByAgentName: 'Lab agent' }, 3_000);
  assert.deepEqual(after.edits, { doccmt_ask: 'Lab agent' });
  const late = advanceAgentThreads(done, { comments: [mention('completed'), answer()], revision: 4, updatedByAgentName: 'Lab agent' }, 2_000 + AGENT_EDIT_WINDOW_MS + 1);
  assert.deepEqual(late.edits, {}, 'a later edit is not this thread\'s');

  // No agent named, no new revision, or a run that was never seen active: no line.
  assert.deepEqual(advanceAgentThreads(start, { comments: [mention('running')], revision: 4 }, 2_000).edits, {});
  assert.deepEqual(advanceAgentThreads(start, { comments: [mention('running')], revision: 3, updatedByAgentName: 'Lab agent' }, 2_000).edits, {});
  const idle = advanceAgentThreads({ ...EMPTY_AGENT_THREADS, revision: 3 }, { comments: [mention('completed'), answer()] }, 1_000);
  assert.deepEqual(advanceAgentThreads(idle, { comments: [mention('completed'), answer()], revision: 4, updatedByAgentName: 'Lab agent' }, 2_000).edits, {});
});

function withHost(element: ReturnType<typeof createElement>, value = host) {
  return createElement(DocumentReaderHostContext.Provider, { value }, element);
}

async function notify(document: DocumentResponse, change: 'content' | 'annotations') {
  await act(async () => {
    notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: document.attachmentId, revision: document.revision ?? 0, change } }]);
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
}

test('in the reader: picker order, the edit offer, live completion, and the Edited by line', async () => {
  await withJsdomRoot(async (mount) => {
    const running = mention('running');
    const document: DocumentResponse = { ...sampleDocument('owner'), comments: [running], reactions: [] };
    const { api } = createMemoryDocumentApi(document);
    const root = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api })));
    await waitForReactCondition(() => Boolean(root.querySelector('#doccmt_ask')), 'the thread renders');
    assert.equal(root.querySelector('#doccmt_ask .app-document-agent-working')?.textContent, 'Lab agent is working');
    assert.equal(buttonLabels(root).includes('Ask Lab agent to edit'), false);

    await click(button(root.querySelector('.app-document-thread') as HTMLElement, 'Mention'));
    const rows = Array.from(root.querySelectorAll('.app-document-mention-list [role="menuitem"]')).map((entry) => entry.textContent?.trim());
    assert.deepEqual(rows, ['Lab agent', 'Field agent', 'Theo']);

    // The agent edits while the run is active.
    const edited: DocumentResponse = { ...document, revision: 4, updatedByAgentName: 'Lab agent' };
    api.setStored(edited);
    await notify(edited, 'content');
    assert.equal(root.querySelector('.app-document-agent-edited')?.textContent, 'Edited by Lab agent');
    assert.equal(root.querySelectorAll('.app-document-agent-working').length, 1);

    // The run completes: the reply replaces the working line in one refresh.
    const completed: DocumentResponse = { ...edited, comments: [mention('completed'), answer()] };
    api.setStored(completed);
    await notify(completed, 'annotations');
    assert.equal(root.querySelectorAll('.app-document-agent-working').length, 0);
    assert.equal(root.querySelector('#doccmt_answer .app-document-agent-tag')?.textContent, 'Agent');
    assert.equal(root.querySelector('.app-document-agent-edited')?.textContent, 'Edited by Lab agent');
    assert.equal(buttonLabels(root).includes('Ask Lab agent to edit'), true, 'the owner may edit');
  });
});

test('in the reader: no Edited by line without the agent name, and no edit offer without edit rights', async () => {
  await withJsdomRoot(async (mount) => {
    const base = sampleDocument('member');
    const document: DocumentResponse = { ...base, comments: [mention('running', { mine: false })], reactions: [], viewerCan: { ...base.viewerCan, edit: false } };
    const { api } = createMemoryDocumentApi(document);
    const root = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api })));
    await waitForReactCondition(() => Boolean(root.querySelector('#doccmt_ask')), 'the thread renders');

    const next: DocumentResponse = { ...document, revision: 4, comments: [mention('completed', { mine: false }), answer()] };
    api.setStored(next);
    await notify(next, 'content');
    assert.equal(Boolean(root.querySelector('#doccmt_answer')), true);
    assert.equal(root.querySelectorAll('.app-document-agent-edited').length, 0);
    assert.equal(buttonLabels(root).includes('Ask Lab agent to edit'), false);
  });
});

test('the Share switch names the document agent and falls back to "the agent"', async () => {
  await withJsdomRoot(async (mount) => {
    const document: DocumentResponse = { ...sampleDocument('owner'), agent: null, comments: [], reactions: [] };
    const { api } = createMemoryDocumentApi(document);
    const root = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api, initialShareOpen: true })));
    assert.equal(Boolean(root.querySelector('[role="switch"][aria-label="Readers can ask the agent"]')), true);
  });
  await withJsdomRoot(async (mount) => {
    const document: DocumentResponse = { ...sampleDocument('owner'), agent: { displayName: 'Desk agent' }, comments: [], reactions: [] };
    const { api } = createMemoryDocumentApi(document);
    const root = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api, initialShareOpen: true })));
    assert.equal(Boolean(root.querySelector('[role="switch"][aria-label="Readers can ask Desk agent"]')), true);
  });
});

test('the review fixture covers a running mention, an answered thread, and a failed one', () => {
  const comments = agentThreadComments();
  assert.deepEqual(comments.map((entry) => entry.agentRun?.status ?? entry.kind ?? null), ['running', 'completed', 'agent', 'failed', 'system']);
});

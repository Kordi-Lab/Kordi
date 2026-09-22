import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildForwardDestinations, createForwardedMessageDraft, createForwardedMessageDrafts, orderedForwardSourcesForMessageIds, revealForwardedMessageInDestination } from '../src/features/chat/messageForwarding';
import { MessageForwardDialog } from '../src/pages/MessageForwardDialog';

const source = {
  sourceSessionId: 'session:one',
  sourceMessageId: 'msg:source',
  senderLabel: 'Alice',
  textPreview: 'Forward this',
  attachmentCount: 0,
  attachments: [],
  attachmentOnly: false,
  createdAtMs: null,
  timeLabel: '10:42',
};

test('createForwardedMessageDraft stores forwardedFrom metadata and text fallback', () => {
  const draft = createForwardedMessageDraft({ source, caption: '', destinationSessionId: 'session:two' });
  assert.equal(draft.text, 'Forward this');
  assert.equal(draft.messageAction.kind, 'forward');
  assert.equal(draft.forwardedFrom.sourceMessageId, source.sourceMessageId);
  assert.equal('attachments' in draft.forwardedFrom, false);
});

test('createForwardedMessageDraft keeps user caption while preserving source metadata', () => {
  const draft = createForwardedMessageDraft({ source, caption: 'FYI', destinationSessionId: 'session:two' });
  assert.equal(draft.text, 'FYI');
  assert.equal(draft.messageAction.source.sourceMessageId, 'msg:source');
});

test('createForwardedMessageDraft preserves an image payload instead of replacing it with an attachment-count label', () => {
  const imageSource = {
    ...source,
    textPreview: '1 attachment',
    attachmentCount: 1,
    attachmentOnly: true,
    attachments: [{
      kind: 'image' as const,
      name: 'screen.png',
      mimeType: 'image/png',
      localPath: '/tmp/screen.png',
      attachmentId: 'att_screen',
    }],
  };

  const draft = createForwardedMessageDraft({ source: imageSource, caption: '', destinationSessionId: 'session:two' });

  assert.equal(draft.text, '');
  assert.deepEqual(draft.attachments, imageSource.attachments);
  assert.notEqual(draft.attachments, imageSource.attachments);
  assert.equal('attachments' in draft.messageAction.source, false);
  assert.doesNotMatch(JSON.stringify(draft.messageAction), /\/tmp\/screen\.png/);
});

test('buildForwardDestinations exposes dense selectable chat labels', () => {
  const destinations = buildForwardDestinations([
    { id: 'local-draft-chat', name: 'Draft', type: 'person', subtitle: '', unread: 0, collaborationSources: [], trust: '', directness: '', participants: [], messages: [] },
    { id: 'conv:one', canonicalSessionId: 'session:self-agent:one', name: 'Research topic', type: 'owned-agent', subtitle: 'Latest message preview', unread: 0, collaborationSources: [], trust: '', directness: 'Agent chat', participants: [], messages: [] },
    { id: 'conv:two', canonicalSessionId: 'session:group:two', name: 'Project group', type: 'person', subtitle: '3 members', unread: 0, collaborationSources: [], trust: '', directness: 'Group chat', participants: [], messages: [] },
    { id: 'conv:three', canonicalSessionId: 'session:direct-person:three', name: 'Alice', type: 'person', subtitle: 'Latest message preview', unread: 0, collaborationSources: [], trust: '', directness: 'Person chat', participants: [], messages: [] },
  ], 'local-draft-chat');

  assert.deepEqual(destinations.map((destination) => destination.id), [
    'session:self-agent:one',
    'session:group:two',
    'session:direct-person:three',
  ]);
  assert.equal(destinations[0].label, 'Research topic');
  assert.equal(destinations[0].conversationId, 'conv:one');
  assert.equal(destinations[0].subtitle, 'Agent chat');
  assert.equal(destinations[1].subtitle, 'Group chat');
  assert.equal(destinations[2].subtitle, 'Direct message');
});

test('revealForwardedMessageInDestination selects destination before revealing forwarded message', () => {
  const calls: string[] = [];

  revealForwardedMessageInDestination({
    destinationConversationId: 'session:two',
    forwardedMessageId: 'msg:forwarded',
    setActiveConversationId: (id) => calls.push(`select:${id}`),
    revealMessage: (id) => calls.push(`reveal:${id}`),
    defer: (callback) => {
      calls.push('defer');
      callback();
    },
  });

  assert.deepEqual(calls, ['select:session:two', 'defer', 'reveal:msg:forwarded']);
});

test('revealForwardedMessageInDestination can switch and fall back to bottom for direct cloud forwards', () => {
  const calls: string[] = [];

  revealForwardedMessageInDestination({
    destinationConversationId: 'bridge:cloud-person:peer',
    forwardedMessageId: null,
    setActiveConversationId: (id) => calls.push(`select:${id}`),
    revealMessage: (id) => calls.push(`reveal:${id}`),
    revealLatest: () => calls.push('latest'),
    defer: (callback) => callback(),
  });

  assert.deepEqual(calls, ['select:bridge:cloud-person:peer', 'latest']);
});

test('forward confirmation validates an existing destination or accepted contact and opens it without creating a session', () => {
  const modelSource = readFileSync(new URL('../src/app/useKordiMessageActions.ts', import.meta.url), 'utf8');
  const start = modelSource.indexOf('const confirmForwardMessage = useCallback');
  const end = modelSource.indexOf('  const messageForwardDialog = forwardDialog', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = modelSource.slice(start, end);

  assert.match(body, /const destinationConversation = conversations\.find/);
  assert.match(body, /if \(!destinationConversation && !contactAvailable\)/);
  assert.match(body, /appendCanonicalMessageFast\(/);
  assert.match(body, /sendCloudCollaborationMessage\(\s*directCloudConversationId/);
  assert.match(body, /prepareCloudForwardAttachments\(\s*draft\.attachments/);
  assert.match(body, /attachments: draft\.attachments/);
  assert.match(body, /attachments,/);
  assert.match(body, /revealForward\(/);
  assert.match(modelSource, /revealForwardedMessageInDestination/);
  assert.doesNotMatch(body, /openOrCreateCanonicalSession/);
  assert.doesNotMatch(body, /createDesktopChatSession/);
  assert.doesNotMatch(body, /generatedSelfAgentSessionId/);
  assert.doesNotMatch(body, /startDesktopChatMessage/);
});

test('createForwardedMessageDrafts keeps multi-forward sources in input order and ignores caption', () => {
  const secondSource = { ...source, sourceMessageId: 'msg:second', senderLabel: 'Bob', textPreview: 'Second' };
  const drafts = createForwardedMessageDrafts({ sources: [source, secondSource], caption: 'ignored' });

  assert.deepEqual(drafts.map((draft) => draft.text), ['Forward this', 'Second']);
  assert.deepEqual(drafts.map((draft) => draft.messageAction.source.senderLabel), ['Alice', 'Bob']);
  assert.deepEqual(drafts.map((draft) => draft.messageAction.kind), ['forward', 'forward']);
});

test('orderedForwardSourcesForMessageIds returns selected sources in transcript order', () => {
  const first = { ...source, sourceMessageId: 'msg:first', textPreview: 'First' };
  const second = { ...source, sourceMessageId: 'msg:second', textPreview: 'Second' };
  const ordered = orderedForwardSourcesForMessageIds(['msg:first', 'msg:second'], new Map([
    ['msg:second', second],
    ['msg:first', first],
  ]));

  assert.deepEqual(ordered.map((entry) => entry.sourceMessageId), ['msg:first', 'msg:second']);
});

test('MessageForwardDialog renders destination picker and source preview', () => {
  const markup = renderToStaticMarkup(
    <MessageForwardDialog
      sources={[source]}
      destinations={[{ id: 'session:two', conversationId: 'conv:two', label: 'Group', subtitle: '3 members' }]}
      onClose={() => {}}
      onForward={() => {}}
    />,
  );

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /Forward message/);
  assert.match(markup, /data-message-forward-destination="session:two"/);
  assert.match(markup, /Alice: Forward this/);
});

test('MessageForwardDialog keeps batch forwarding focused on destinations without a preview or caption', () => {
  const secondSource = { ...source, sourceMessageId: 'msg:second', senderLabel: 'Bob', textPreview: 'Second' };
  const markup = renderToStaticMarkup(
    <MessageForwardDialog
      sources={[source, secondSource]}
      destinations={[{ id: 'session:two', conversationId: 'conv:two', label: 'Group', subtitle: '3 members' }]}
      onClose={() => {}}
      onForward={() => {}}
    />,
  );

  assert.match(markup, /Forward 2 messages/);
  assert.doesNotMatch(markup, /Selected preview/);
  assert.doesNotMatch(markup, /data-message-forward-selected-preview/);
  assert.doesNotMatch(markup, /Alice: Forward this/);
  assert.doesNotMatch(markup, /Bob: Second/);
  assert.doesNotMatch(markup, /Add a comment/);
});

test('MessageForwardDialog uses theme-safe shell classes and exposes forward mode', () => {
  const markup = renderToStaticMarkup(
    <MessageForwardDialog
      sources={[source]}
      destinations={[{ id: 'session:two', conversationId: 'conv:two', label: 'Group', subtitle: '3 members' }]}
      onClose={() => {}}
      onForward={() => {}}
    />,
  );

  assert.match(markup, /app-message-forward-dialog/);
  assert.match(markup, /app-transient-overlay/);
  assert.match(markup, /app-transient-surface/);
  assert.match(markup, /data-message-forward-dialog="true"/);
  assert.match(markup, /data-message-forward-mode="single"/);
  assert.match(markup, /app-transient-divider/);
  assert.doesNotMatch(markup, /bg-\[#101820\]/);
});

test('forward destinations preserve group context, search public identities, and sort by activity', async () => {
  const { conversation, contact } = await import('./helpers/workspaceSidebarParticipantSpacesFixtures');
  const { filterForwardDestinations, forwardDestinationPath } = await import('../src/features/chat/messageForwarding');
  const group = (id: string, title: string, updatedAt: number) => conversation({
    id, canonicalSessionId: id, name: 'General', type: 'group', participantSpaceId: id,
    metadata: { groupSpaceId: id, customName: title }, _updatedAtMs: updatedAt,
  });
  const people = contact({ id: 'cloud:avery', name: 'Avery Morgan', entityType: 'user', sourceHostId: 'cloud', sourceParticipantId: 'avery', contactStatus: 'accepted', subtitle: '@123456789' });
  const input = [group('session:group:research', 'Research circle', 100), group('session:group:product', 'Product team', 200)];
  const destinations = buildForwardDestinations(input, undefined, [people, { ...people, id: 'pending', sourceParticipantId: 'pending', contactStatus: 'pending' }]);
  assert.deepEqual(destinations.map((item) => item.label), ['General', 'General', 'Avery Morgan']);
  assert.equal(forwardDestinationPath(destinations[0]), 'Product team › General');
  assert.equal(forwardDestinationPath(destinations[1]), 'Research circle › General');
  assert.equal(forwardDestinationPath(destinations[2]), 'Avery Morgan · @123456789');
  assert.equal(filterForwardDestinations(destinations, 'research')[0].id, 'session:group:research');
  assert.equal(filterForwardDestinations(destinations, '123456789', 'person')[0].label, 'Avery Morgan');
  assert.equal(filterForwardDestinations(destinations, 'morgan avery', 'person').length, 1);
  assert.equal(filterForwardDestinations(destinations, 'Morgan', 'agent').length, 0);
  assert.equal(input[0].id, 'session:group:research');
});

test('forward destinations omit temporary resources and deduplicate accepted contacts', async () => {
  const { conversation, contact } = await import('./helpers/workspaceSidebarParticipantSpacesFixtures');
  const { forwardContactConversationId } = await import('../src/features/chat/messageForwarding');
  const person = contact({ id: 'cloud:alice', entityType: 'user', sourceHostId: 'cloud', sourceParticipantId: 'alice', contactStatus: 'accepted', subtitle: '@123456789' });
  const id = forwardContactConversationId(person)!;
  const destinations = buildForwardDestinations([
    conversation({ id, canonicalSessionId: 'session:direct-person:alice', _updatedAtMs: 300 }),
    conversation({ id: 'draft:local', transientDraft: true }),
    conversation({ id: 'execution', agentSubsessionId: 'execution-resource' }),
  ], undefined, [person]);
  assert.equal(destinations.length, 1);
  assert.equal(destinations[0].identityLabel, '@123456789');
  assert.equal(destinations[0].updatedAtMs, 300);
});

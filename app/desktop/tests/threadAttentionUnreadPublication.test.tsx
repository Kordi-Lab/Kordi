import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { decorateCloudConversations } from '../src/app/viewModels/cloudConversationPresence';
import { EMPTY_CLOUD_SESSION_ACTIVITY } from '../src/features/cloud/cloudSessionActivity';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { conversation, baseSidebarProps } from './helpers/workspaceSidebarParticipantSpacesFixtures';

function sidebar(liveUnread: number, polledUnread: number, threadUnread = 0) {
  const id = 'session:direct-person:me:peer';
  const conversations = decorateCloudConversations([
    conversation({ id, canonicalSessionId: id, unread: liveUnread }),
  ], EMPTY_CLOUD_SESSION_ACTIVITY, {
    [id]: { conversation_id: 'conversation', session_id: id, unread_count: polledUnread,
      thread_unread_count: threadUnread, thread_count: threadUnread ? 1 : 0,
      next_root_id: threadUnread ? 'root' : null, next_message_id: threadUnread ? 'reply' : null },
  });
  const spaces = buildParticipantSpaces(conversations);
  return {
    conversations,
    markup: renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
      activeConvId: '', chatConversations: conversations,
      participantSpaces: spaces, contactParticipantSpaces: spaces,
    }) as never)),
  };
}

test('the final sidebar shows a live unread while the attention poll still says zero', () => {
  const { conversations, markup } = sidebar(1, 0);
  assert.equal(conversations[0].unread, 1);
  assert.match(markup, /data-unread-scope="channel-tab" data-unread-count="1"/);
  assert.match(markup, /data-unread-scope="participant-space" data-unread-count="1"/);
});

test('the final sidebar clears a locally read message before the attention poll catches up', () => {
  const { conversations, markup } = sidebar(0, 1);
  assert.equal(conversations[0].unread, 0);
  assert.doesNotMatch(markup, /data-unread-count=/);
});

test('genuinely unread discussions retain their independent attention total', () => {
  const { conversations, markup } = sidebar(0, 3, 3);
  assert.equal(conversations[0].unread, 3);
  assert.match(markup, /Jump to next unread thread/);
  assert.match(markup, /data-unread-count="3"/);
});

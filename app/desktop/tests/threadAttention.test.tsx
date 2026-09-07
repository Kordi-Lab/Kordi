import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SidebarSessionMetaColumn} from '../src/pages/workspaceSidebar.shared';
import {ThreadShortcut} from '../src/features/chat/ThreadShortcut';
import {transcriptMessageNavigationIds} from '../src/features/chat/transcriptMessageIdentity';
import {newMessageAttentionEvents,messageAttentionSnapshot} from '../src/features/notifications/messageAttentionPolicy';
import type {Conversation,Message} from '../src/kordi-app/types';

test('thread shortcut leaves the sidebar total as one count and uses an accessible symbol',()=>{
  const attention={conversation_id:'conversation',session_id:'session',unread_count:7,thread_count:2,next_root_id:'root',next_message_id:'reply'};
  const html=renderToStaticMarkup(createElement(SidebarSessionMetaColumn,{timeLabel:'10:42',unreadCount:7,unreadMentionCount:1,threadAttention:attention}));
  assert.match(html,/data-unread-count="7"/);
  assert.match(html,/aria-label="Jump to next unread thread"/);
  assert.doesNotMatch(html,/>Unread threads</);
  assert.doesNotMatch(html,/data-unread-count="2"/);
  const button=renderToStaticMarkup(createElement(ThreadShortcut,{count:2,onClick:()=>{}}));
  assert.match(button,/Jump to next unread thread/);
  assert.match(button,/>2</);
  assert.equal(renderToStaticMarkup(createElement(ThreadShortcut,{count:0,onClick:()=>{}})),'');
});

test('notification lookup includes canonical and client aliases and retains thread routing',()=>{
  const message:Message={id:'display-reply',reactionTargetMessageId:'canonical-reply',clientMessageId:'client-reply',role:'person',text:'New reply',time:'10:42',messageAction:{schemaVersion:1,kind:'thread',source:{sourceMessageId:'root',sourceSessionId:'session',sourceMessageKind:'text',senderLabel:'Maya',textPreview:'Original',attachmentCount:0,createdAtMs:null,timeLabel:null}}};
  assert(transcriptMessageNavigationIds(message).includes('canonical-reply'));
  assert(transcriptMessageNavigationIds(message).includes('client-reply'));
  const conversation={id:'session',name:'Team',unread:1,messages:[message]} as Conversation;
  const events=newMessageAttentionEvents({previous:{},conversations:[conversation]});
  assert.equal(events[0].threadRootId,'root');
  assert.equal(newMessageAttentionEvents({previous:messageAttentionSnapshot([conversation]),conversations:[conversation]}).length,0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import type { ConversationType, NavId, SessionStatusIndicator } from '../src/kordi-app/types';

const noop = () => {};
const noopSet = noop as never;

function conversation({
  id,
  label,
  unread = 0,
}: {
  id: string;
  label: string;
  unread?: number;
}) {
  return {
    id,
    name: id,
    subtitle: '',
    unread,
    messages: [{ time: '21:38' }],
    updatedAtLabel: '21:38',
    type: 'owned-agent' as ConversationType,
    statusIndicator: {
      label,
      tone: 'running',
      live: true,
    } satisfies SessionStatusIndicator,
  };
}

test('active chat rows suppress read status lights from the sidebar', () => {
  const activeConversation = conversation({
    id: 'session-active',
    label: 'Active running indicator should be hidden after read',
    unread: 1,
  });
  const backgroundConversation = conversation({
    id: 'session-background',
    label: 'Background running indicator should remain visible',
  });

  const html = renderToStaticMarkup(
    <WorkspaceSidebar
      isNativeShell
      isSingleWorkspacePage={false}
      collapseChatSessions={false}
      showSessionRail
      sessionRailWidth={260}
      activeNav={'chats' as NavId}
      setActiveNav={noopSet}
      chatConversations={[activeConversation, backgroundConversation]}
      onCreateChatSession={noop}
      chatSearch=""
      setChatSearch={noopSet}
      chatFilter="all"
      setChatFilter={noopSet}
      isDesktopChatLoading={false}
      desktopChatError={null}
      filteredConversations={[activeConversation, backgroundConversation]}
      activeConvId="session-active"
      onSelectChatSession={noop}
      onArchiveChatSession={noop}
      onDeleteChatSession={noop}
      onMoveChatSessionToProject={noop}
      onCreateProjectFromFolder={noop}
      onCreateProject={noop}
      runtimeProjects={[]}
      projectSearch=""
      setProjectSearch={noopSet}
      filteredProjects={[]}
      activeProjectId=""
      activeProjectSessionId=""
      projectSelectedSessionIds={{}}
      selectProject={noop}
      expandedProjectIds={{}}
      setExpandedProjectIds={noopSet}
      onSelectProjectSession={noop}
      groupedContacts={[]}
      displayedContacts={[]}
      setActiveContactGroup={noopSet}
      setActiveContactId={noopSet}
      displayedAgents={[]}
      activeBridgeHost={null}
      localProfileAvatarSeed="test-human"
      onRefreshBridge={noop}
      onCopyBridgeHostUrl={noop}
      onCreateBridgeDraft={noop}
    />,
  );

  assert.equal(html.includes('Active running indicator should be hidden after read'), false);
  assert.equal(html.includes('Background running indicator should remain visible'), true);
});

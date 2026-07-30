import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useWorkspaceViewModels } from '../src/app/useWorkspaceViewModels';

test('workspace view model hides cloud-agent runtime sessions from local chat UI', () => {
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;
  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: {
        cwd: '/tmp',
        activeSessionId: 'cloud-agent:acct_me:acct_peer',
        sessions: [
          { id: 'cloud-agent:acct_me:acct_peer', title: 'Cloud agent runtime', subtitle: 'hidden', updatedAtLabel: '12:00', messageCount: 1, draft: false },
          { id: 'local-visible', title: 'Visible local chat', subtitle: 'shown', updatedAtLabel: '12:01', messageCount: 1, draft: false },
        ],
        projects: [],
        activeSession: {
          id: 'cloud-agent:acct_me:acct_peer',
          title: 'Cloud agent runtime',
          subtitle: 'hidden',
          provider: 'openai',
          providerLabel: 'OpenAI',
          model: 'gpt',
          modelLabel: 'GPT',
          thinking: 'default',
          thinkingLabel: 'Default',
          thinkingLevels: [],
          updatedAtLabel: '12:00',
          messageCount: 1,
          draft: false,
          contextWindowText: '',
          contextWindowStatus: { contextWindow: 0, usedTokens: 0, percentUsed: 0, status: 'ok' },
          project: null,
          messages: [{ role: 'user', text: 'internal prompt', timeLabel: '12:00', timestampMs: 1 }],
        },
        localAgent: { label: 'Kordi', systemPrompt: '', loadedSkills: [], loadedTools: [], loadedPlugins: [], identityFiles: [], defaultProvider: 'openai', defaultModel: 'gpt', workspaceRoot: '/tmp', lastActivities: [] },
        modelOptions: [],
        slashCommands: [],
      } as never,
      desktopCollaborationState: null,
      canonicalSessionState: null,
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: 'my-agent',
      activeProjectId: '',
      activeProjectSessionId: '',
      chatSearch: '',
      projectSearch: '',
      contactSearch: '',
      activeContactId: '',
      activeAgentId: '',
      cachedChatSessionMessages: {},
      cachedProjectSessionMessages: {},
      localSessionUnreadCounts: {},
      desktopLiveTurnsBySession: {},
      mapDesktopMessages: (_sessionId, messages) => messages.map((message) => ({ role: message.role === 'assistant' ? 'owned-agent' : 'user', text: message.text, time: message.timeLabel })),
    });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  assert.equal(viewModels?.chatConversations.some((conversation) => conversation.id.startsWith('cloud-agent:')), false);
  assert.equal(viewModels?.activeConv.id, 'local-visible');
});

test('workspace view model exposes visible non-contact Bridge people for Add contacts only', () => {
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;
  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: null,
      desktopCollaborationState: {
        activeHostId: 'host-1',
        hosts: [{
          id: 'host-1',
          registered: true,
          connected: true,
          serverUrl: 'https://bridge.test',
          nodeId: 'kd_me',
          displayName: 'Me',
          ownerName: 'Me',
          endpoint: 'https://bridge.test/kd_me',
          tokenPresent: true,
          humanId: 'kh_me',
          discoveryMode: 'open',
          humanVisibilityPolicy: 'server-approval',
          contactApprovalPolicy: 'approval-required',
          activeAgentId: null,
          agents: [],
          visiblePeers: [{
            nodeId: 'kd_visible',
            displayName: 'Kordi User 6',
            runtime: 'person',
            endpoint: '',
            ownerName: 'Kordi User 6',
            createdAt: null,
            sharedProjects: [],
            humanId: 'kh_visible',
            agentId: null,
            isDefaultAgent: false,
            discoveryMode: null,
            humanVisibilityPolicy: 'server-approval',
            contactApprovalPolicy: 'approval-required',
            agentReachabilityPolicy: 'contacts',
            isContact: false,
            contactRequestStatus: null,
            contactRequestDirection: null,
          }, {
            nodeId: 'kd_contact',
            displayName: 'Existing Contact',
            runtime: 'person',
            endpoint: '',
            ownerName: 'Existing Contact',
            createdAt: null,
            sharedProjects: [],
            humanId: 'kh_contact',
            agentId: null,
            isDefaultAgent: false,
            discoveryMode: null,
            humanVisibilityPolicy: 'server-open',
            contactApprovalPolicy: 'auto',
            agentReachabilityPolicy: 'contacts',
            isContact: true,
            contactRequestStatus: 'contact',
            contactRequestDirection: null,
          }],
          visiblePeerCount: 2,
          projects: [],
          contactRequests: [],
          lastError: null,
        }],
        conversations: [],
      } as never,
      canonicalSessionState: null,
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'contacts',
      activeConvId: '',
      activeProjectId: '',
      activeProjectSessionId: '',
      chatSearch: '',
      projectSearch: '',
      contactSearch: '',
      activeContactId: '',
      activeAgentId: '',
      cachedChatSessionMessages: {},
      cachedProjectSessionMessages: {},
      localSessionUnreadCounts: {},
      desktopLiveTurnsBySession: {},
      mapDesktopMessages: () => [],
    });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  assert.deepEqual(viewModels?.addableContacts.map((contact) => contact.name), ['Kordi User 6']);
  assert.equal(viewModels?.displayedContacts.some((contact) => contact.name === 'Kordi User 6'), false);
  assert.equal(viewModels?.displayedContacts.some((contact) => contact.name === 'Existing Contact'), true);
});

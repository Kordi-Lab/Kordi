import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  bridgeAgentRoutingChangeNotice,
  bridgeAgentRoutingNotice,
  bridgeChatRoutingControlVisibility,
  localOwnedBridgeAgentsForModelRouting,
  routingSelectionForBridgeAgent,
} from '../src/features/bridge/agentModelRouting';
import { AgentDetailPane } from '../src/kordi-app/agents/AgentDetailPane';
import { BRIDGE_ROUTING_NOTICE_AUTO_DISMISS_MS, BRIDGE_ROUTING_NOTICE_EXIT_MS } from '../src/pages/ChatsPage';
import type { Agent, DesktopBridgeHost, DesktopChatState } from '../src/kordi-app/types';

const hosts: DesktopBridgeHost[] = [
  {
    id: 'host-1',
    registered: true,
    connected: true,
    serverUrl: 'https://bridge.example',
    nodeId: 'human-node',
    displayName: 'Shuyang',
    ownerName: 'Shuyang',
    endpoint: 'local',
    tokenPresent: true,
    humanId: 'human-1',
    discoveryMode: 'contacts',
    activeAgentId: 'agent-a',
    visiblePeerCount: 1,
    projects: [],
    visiblePeers: [
      {
        nodeId: 'remote-agent-node',
        displayName: 'Remote Kordi',
        runtime: 'kordi-desktop',
        endpoint: 'remote',
        ownerName: 'Peer',
        sharedProjects: [],
        agentId: 'remote-agent',
      },
    ],
    agents: [
      {
        id: 'agent-a',
        label: "Shuyang's Kordi",
        nodeId: 'agent-node-a',
        runtime: 'kordi-desktop',
        isDefault: true,
        isActive: true,
        registered: true,
        defaultModel: 'openai/gpt-5.4',
        defaultAuthProvider: 'openai-codex',
        defaultAuthChoice: 'profile:chatgpt-e96dde',
        fallbackModel: 'anthropic/claude-sonnet-4.5',
        fallbackAuthProvider: 'anthropic',
        fallbackAuthChoice: 'env:api-key',
        thinking: 'high',
      },
      {
        id: 'agent-b',
        label: 'Reviewer Kordi',
        nodeId: 'agent-node-b',
        runtime: 'kordi-desktop',
        isDefault: false,
        isActive: false,
        registered: true,
        defaultModel: 'anthropic/claude-opus-4.1',
        fallbackModel: null,
        thinking: 'medium',
      },
    ],
  },
];

const desktopChatState = {
  localAgent: {
    label: 'Runtime Kordi',
    defaultProvider: 'openai',
    defaultModel: 'gpt-5.4',
  },
} as DesktopChatState;

test('localOwnedBridgeAgentsForModelRouting returns only agents owned by local bridge hosts', () => {
  const agents = localOwnedBridgeAgentsForModelRouting(hosts, desktopChatState);

  assert.deepEqual(agents.map((agent) => agent.id), ['agent-a', 'agent-b']);
  assert.equal(agents.some((agent) => agent.id === 'remote-agent'), false);
});

test('routingSelectionForBridgeAgent uses per-agent default, fallback, and thinking values', () => {
  const [agent] = localOwnedBridgeAgentsForModelRouting(hosts, desktopChatState);

  assert.deepEqual(routingSelectionForBridgeAgent(agent), {
    mode: 'My agent',
    model: 'openai/gpt-5.4',
    authProvider: 'openai-codex',
    authChoice: 'profile:chatgpt-e96dde',
    fallbackModel: 'anthropic/claude-sonnet-4.5',
    thinking: 'high',
  });
});

test('bridgeAgentRoutingNotice is local-only copy with agent label and fallback', () => {
  assert.equal(
    bridgeAgentRoutingNotice({
      agentLabel: "Shuyang's Kordi",
      modelLabel: 'GPT-5.4',
      fallbackLabel: 'Claude Sonnet 4.5',
    }),
    "Shuyang's Kordi model changed to GPT-5.4. Fallback: Claude Sonnet 4.5. Only you can see this.",
  );
});

test('bridge chat routing controls keep fallback out of the composer', () => {
  assert.deepEqual(bridgeChatRoutingControlVisibility(1), {
    showAgentSelector: false,
    showFallback: false,
  });
  assert.deepEqual(bridgeChatRoutingControlVisibility(2), {
    showAgentSelector: true,
    showFallback: false,
  });
});

test('bridgeAgentRoutingChangeNotice returns null when the selected value is unchanged', () => {
  assert.equal(
    bridgeAgentRoutingChangeNotice({
      agentLabel: "Shuyang's Kordi",
      currentModel: 'openai/gpt-5.4',
      nextModel: 'openai/gpt-5.4',
      currentThinking: 'high',
      nextThinking: undefined,
      modelLabel: 'GPT-5.4',
      thinkingLabel: 'High',
    }),
    null,
  );
});

test('bridgeAgentRoutingChangeNotice reports only the changed private setting', () => {
  assert.equal(
    bridgeAgentRoutingChangeNotice({
      agentLabel: "Shuyang's Kordi",
      currentModel: 'openai/gpt-5.4',
      nextModel: undefined,
      currentThinking: 'medium',
      nextThinking: 'high',
      modelLabel: 'GPT-5.4',
      thinkingLabel: 'High',
    }),
    "Shuyang's Kordi thinking set to High. Only you can see this.",
  );
});

test('bridge routing notice auto-dismisses after two seconds with a short fade', () => {
  assert.equal(BRIDGE_ROUTING_NOTICE_AUTO_DISMISS_MS, 2000);
  assert.ok(BRIDGE_ROUTING_NOTICE_EXIT_MS > 0);
  assert.ok(BRIDGE_ROUTING_NOTICE_EXIT_MS <= 300);
});

test('owned agent inspector surfaces default and fallback model routing before runtime details', () => {
  const agent: Agent = {
    name: "Shuyang's Kordi",
    id: 'agent-a',
    role: 'My agent',
    messaging: 'Direct local chat',
    status: 'Active',
    tasks: 0,
    defaultProvider: 'OpenAI',
    defaultModel: 'openai/gpt-5.5-codex-max-preview-2026-04',
    defaultAuthProvider: 'openai-codex',
    defaultAuthChoice: 'profile:chatgpt-e96dde',
    fallbackModel: 'anthropic/claude-3-7-sonnet-20250219-thinking',
    fallbackAuthProvider: 'anthropic',
    fallbackAuthChoice: 'profile:claude-3d9dab',
    defaultThinking: 'high',
    bridgesConfig: 'bridge.example',
    contactId: 'bridge-agent:host-1:agent-a',
    systemPrompt: 'You are an expert coding assistant.',
    xMd: '/tmp/workspace',
    identityFiles: [],
    loadedTools: ['read'],
    loadedSkills: ['audit'],
    loadedPlugins: [],
    lastActivities: [],
    exposesIdentityFiles: true,
    exposesLoadedSkills: true,
    exposesLoadedTools: true,
    exposesLoadedPlugins: true,
    bridgeHostId: 'host-1',
    bridgeAgentId: 'agent-a',
    bridgePeerNodeId: 'agent-node-a',
    isOwned: true,
    isBridgeActive: true,
  };

  const markup = renderToStaticMarkup(createElement(AgentDetailPane, {
    activeAgent: agent,
    activeAgentConfig: {
      systemPrompt: agent.systemPrompt,
      loadedSkills: agent.loadedSkills,
      identityFiles: agent.identityFiles,
    },
    activePersistedConfig: null,
    activeDetail: { kind: 'prompt' },
    activeSaveFeedback: null,
    activeEditingSection: null,
    availableSkills: agent.loadedSkills,
    chatModelOptions: [
      {
        value: 'openai/gpt-5.5-codex-max-preview-2026-04',
        label: 'gpt-5.5-codex-max-preview-2026-04',
        provider: 'openai',
        providerLabel: 'OpenAI Codex',
        thinkingLevels: ['off', 'medium', 'high'],
      },
      {
        value: 'openai/gpt-5.4',
        label: 'gpt-5.4',
        provider: 'openai',
        providerLabel: 'OpenAI API',
        thinkingLevels: ['off', 'medium', 'high'],
      },
      {
        value: 'anthropic/claude-3-7-sonnet-20250219-thinking',
        label: 'claude-3-7-sonnet-20250219-thinking',
        provider: 'anthropic',
        providerLabel: 'Anthropic',
        thinkingLevels: ['off', 'medium'],
      },
    ],
    composerProviderOptions: [
      {
        value: 'openai-codex::profile:chatgpt-e96dde',
        providerId: 'openai-codex',
        label: 'ChatGPT account',
        detail: 'oauth id e96dde • account e96dde',
        selectionLabel: 'ChatGPT account • oauth id e96dde',
        active: true,
      },
      {
        value: 'openai::env:api-key',
        providerId: 'openai',
        label: 'OpenAI API key',
        detail: 'api id env',
        selectionLabel: 'OpenAI API key • api id env',
        active: false,
      },
      {
        value: 'anthropic::profile:claude-3d9dab',
        providerId: 'anthropic',
        label: 'Claude subscription',
        detail: 'oauth id 3d9dab • claude.ai',
        selectionLabel: 'Claude subscription • oauth id 3d9dab',
        active: true,
      },
      {
        value: 'anthropic::env:api-key',
        providerId: 'anthropic',
        label: 'Anthropic API key',
        detail: 'api id env',
        selectionLabel: 'Anthropic API key • api id env',
        active: false,
      },
    ],
    onUpdateModelRouting: () => undefined,
    onReset: () => undefined,
    onMessage: () => undefined,
    onOpenPromptDetail: () => undefined,
    onStartEditing: () => undefined,
    onSave: () => undefined,
    onCancelEditing: () => undefined,
    onToggleSkill: () => undefined,
    onSelectIdentityFile: () => undefined,
  }));

  const routingIndex = markup.indexOf('Model routing');
  const overviewIndex = markup.indexOf('Overview');

  assert.notEqual(routingIndex, -1);
  assert.match(markup, /Default route/);
  assert.match(markup, /Fallback route/);
  assert.match(markup, /ChatGPT account · oauth id e96dde • account e96dde · gpt-5\.5-codex-max-preview-2026-04/);
  assert.match(markup, /Claude subscription · oauth id 3d9dab • claude\.ai · claude-3-7-sonnet-20250219-thinking/);
  assert.doesNotMatch(markup, />OpenAI · gpt-5\.5-codex-max-preview-2026-04</);
  assert.match(markup, /class="[^"]*whitespace-normal[^"]*break-words[^"]*"[^>]*>ChatGPT account · oauth id e96dde • account e96dde · gpt-5\.5-codex-max-preview-2026-04/);
  assert.match(markup, /class="[^"]*whitespace-normal[^"]*break-words[^"]*"[^>]*>Claude subscription · oauth id 3d9dab • claude\.ai · claude-3-7-sonnet-20250219-thinking/);
  assert.doesNotMatch(markup, /class="[^"]*truncate[^"]*"[^>]*>ChatGPT account · oauth id e96dde/);
  assert.doesNotMatch(markup, /class="[^"]*truncate[^"]*"[^>]*>Claude subscription · oauth id 3d9dab/);
  assert.match(markup, /Thinking level/);
  assert.match(markup, /Save routing/);
  assert.doesNotMatch(markup, /Identity metadata/);
  assert.doesNotMatch(markup, /<select/);
  assert.ok(routingIndex < overviewIndex, 'model routing should be visible before overview/runtime sections');
});

test('owned agent inspector resolves bare runtime defaults through the same provider/model route options as sessions', () => {
  const agent: Agent = {
    name: "Shuyang's Kordi",
    id: 'agent-a',
    role: 'My agent',
    messaging: 'Direct local chat',
    status: 'Active',
    tasks: 0,
    defaultProvider: 'openai',
    defaultModel: 'gpt-5.5',
    defaultAuthProvider: null,
    defaultAuthChoice: null,
    fallbackModel: null,
    fallbackAuthProvider: null,
    fallbackAuthChoice: null,
    defaultThinking: 'high',
    bridgesConfig: 'bridge.example',
    contactId: 'bridge-agent:host-1:agent-a',
    systemPrompt: 'You are an expert coding assistant.',
    xMd: '/tmp/workspace',
    identityFiles: [],
    loadedTools: [],
    loadedSkills: [],
    loadedPlugins: [],
    lastActivities: [],
    exposesIdentityFiles: true,
    exposesLoadedSkills: true,
    exposesLoadedTools: true,
    exposesLoadedPlugins: true,
    bridgeHostId: 'host-1',
    bridgeAgentId: 'agent-a',
    bridgePeerNodeId: 'agent-node-a',
    isOwned: true,
    isBridgeActive: true,
  };

  const markup = renderToStaticMarkup(createElement(AgentDetailPane, {
    activeAgent: agent,
    activeAgentConfig: {
      systemPrompt: agent.systemPrompt,
      loadedSkills: agent.loadedSkills,
      identityFiles: agent.identityFiles,
    },
    activePersistedConfig: null,
    activeDetail: { kind: 'prompt' },
    activeSaveFeedback: null,
    activeEditingSection: null,
    availableSkills: agent.loadedSkills,
    chatModelOptions: [
      {
        value: 'openai/gpt-5.5',
        label: 'gpt-5.5',
        provider: 'openai',
        providerLabel: 'OpenAI',
        thinkingLevels: ['off', 'medium', 'high'],
      },
      {
        value: 'anthropic/claude-sonnet-4.5',
        label: 'claude-sonnet-4.5',
        provider: 'anthropic',
        providerLabel: 'Anthropic',
        thinkingLevels: ['off', 'medium'],
      },
    ],
    composerProviderOptions: [
      {
        value: 'openai-codex::profile:chatgpt-e96dde',
        providerId: 'openai-codex',
        label: 'ChatGPT account',
        detail: 'oauth id e96dde • account e96dde',
        selectionLabel: 'ChatGPT account • oauth id e96dde',
        active: true,
      },
      {
        value: 'openai::env:api-key',
        providerId: 'openai',
        label: 'OpenAI API key',
        detail: 'api id env',
        selectionLabel: 'OpenAI API key • api id env',
        active: false,
      },
    ],
    onUpdateModelRouting: () => undefined,
    onReset: () => undefined,
    onMessage: () => undefined,
    onOpenPromptDetail: () => undefined,
    onStartEditing: () => undefined,
    onSave: () => undefined,
    onCancelEditing: () => undefined,
    onToggleSkill: () => undefined,
    onSelectIdentityFile: () => undefined,
  }));

  assert.match(markup, /Default route/);
  assert.match(markup, /ChatGPT account · oauth id e96dde • account e96dde · gpt-5\.5/);
  assert.match(markup, /Unsaved route changes\. Save when ready\./);
  assert.doesNotMatch(markup, /disabled="">Save routing/);
  assert.doesNotMatch(markup, />gpt-5\.5<\/span>/);
});

test('owned local runtime agent keeps editable default and fallback routing before Bridge registration', () => {
  const agent: Agent = {
    name: 'Local Kordi',
    id: 'desktop:local-agent',
    role: 'Local desktop agent',
    messaging: 'Local runtime',
    status: 'Active',
    tasks: 0,
    defaultProvider: 'openai',
    defaultModel: 'gpt-5.5',
    bridgesConfig: 'Local runtime',
    contactId: 'desktop:local-agent',
    systemPrompt: 'You are an expert coding assistant.',
    xMd: '/tmp/workspace',
    identityFiles: [],
    loadedTools: [],
    loadedSkills: [],
    loadedPlugins: [],
    lastActivities: [],
    exposesIdentityFiles: true,
    exposesLoadedSkills: true,
    exposesLoadedTools: true,
    exposesLoadedPlugins: true,
    isOwned: true,
    isBridgeActive: true,
  };

  const markup = renderToStaticMarkup(createElement(AgentDetailPane, {
    activeAgent: agent,
    activeAgentConfig: {
      systemPrompt: agent.systemPrompt,
      loadedSkills: agent.loadedSkills,
      identityFiles: agent.identityFiles,
    },
    activePersistedConfig: null,
    activeDetail: { kind: 'prompt' },
    activeSaveFeedback: null,
    activeEditingSection: null,
    availableSkills: agent.loadedSkills,
    chatModelOptions: [
      {
        value: 'openai/gpt-5.5',
        label: 'gpt-5.5',
        provider: 'openai',
        providerLabel: 'OpenAI',
        detail: 'OpenAI',
        thinkingLevels: ['off', 'medium', 'high'],
      },
    ],
    composerProviderOptions: [
      {
        value: 'openai-codex::profile:chatgpt-e96dde',
        providerId: 'openai-codex',
        label: 'ChatGPT account',
        detail: 'oauth id e96dde • account e96dde',
        selectionLabel: 'ChatGPT account • oauth id e96dde',
        active: true,
      },
    ],
    onUpdateModelRouting: () => undefined,
    onReset: () => undefined,
    onMessage: () => undefined,
    onOpenPromptDetail: () => undefined,
    onStartEditing: () => undefined,
    onSave: () => undefined,
    onCancelEditing: () => undefined,
    onToggleSkill: () => undefined,
    onSelectIdentityFile: () => undefined,
  }));

  assert.match(markup, /Model routing/);
  assert.match(markup, /Default route/);
  assert.match(markup, /Fallback route/);
  assert.match(markup, /Saved locally until this agent is connected to Bridge/);
  assert.match(markup, /Unsaved route changes\. Save when ready\./);
  assert.doesNotMatch(markup, /Register this agent on a Bridge host before setting default or fallback routes\./);
  assert.doesNotMatch(markup, /disabled="">Save routing/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useKordiUiEffects } from '../src/app/useKordiUiEffects';
import { ComposerModelControls } from '../src/kordi-app/components';

type SelectorState = {
  scope: 'chat' | 'project';
  type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking';
} | null;

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  return {
    dom,
    restore() {
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}

test('agent-session portaled model menu commits Claude Fable 5 before closing', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let selectedModel = 'anthropic/claude-opus-4-8';
  const noop = () => undefined;
  const refreshDesktopChat = async () => null;

  function Harness() {
    const [selection, setSelection] = useState({
      mode: 'agent',
      model: 'anthropic/claude-opus-4-8',
      thinking: 'medium',
    });
    const [openSelector, setOpenSelector] = useState<SelectorState>(null);
    const composerControlsRef = useRef<HTMLDivElement | null>(null);
    const chatTranscriptScrollRef = useRef<HTMLDivElement | null>(null);
    const shouldAutoFollowChatRef = useRef(true);
    selectedModel = selection.model;

    useKordiUiEffects({
      isNativeShell: false,
      desktopChatState: null,
      desktopAuthState: null,
      refreshDesktopChat,
      activeNav: 'settings',
      activeConvId: 'session:self-agent:test',
      activeProjectId: '',
      activeProjectSessionId: '',
      setActiveConvId: noop,
      displayedContacts: [],
      activeContactId: '',
      setActiveContactId: noop,
      setActiveContactGroup: noop,
      displayedAgents: [],
      activeAgentId: '',
      setActiveAgentId: noop,
      setActiveSourcePreview: noop,
      setActiveArtifactId: noop,
      setOpenComposerSelector: setOpenSelector,
      setChatComposerAttachments: noop,
      openComposerSelector: openSelector,
      composerControlsRef,
      themeMode: 'dark',
      activeConversationIsBridge: false,
      setDesktopSessionRenameDraft: noop,
      setIsEditingDesktopSessionTitle: noop,
      setComposerSelections: noop,
      chatTranscriptScrollRef,
      shouldAutoFollowChatRef,
      activeConvMessagesLength: 0,
      activeProjectSessionIdValue: '',
      activeProjectSessionMessagesLength: 0,
      desktopLiveTurn: null,
      setChatSlashMenuIndex: noop,
      chatSlashQuery: null,
      filteredChatSlashCommandsLength: 0,
      projectSlashQuery: null,
      filteredProjectSlashCommandsLength: 0,
    });

    return (
      <div ref={composerControlsRef}>
        <ComposerModelControls
          scope="chat"
          selection={selection}
          openSelector={openSelector}
          onToggleSelector={(_scope, type) => setOpenSelector((current) => (
            current?.type === type ? null : { scope: 'chat', type }
          ))}
          onSelectValue={(_scope, type, value) => {
            if (type === 'model') {
              setSelection((current) => ({ ...current, model: value }));
            }
            setOpenSelector(null);
          }}
          authLabel="Claude subscription"
          authOptions={[]}
          onSelectAuthChoice={() => undefined}
          onSelectProviderChoice={() => undefined}
          providerOptions={[{
            value: 'anthropic::subscription',
            providerId: 'anthropic',
            label: 'Claude subscription',
            active: true,
          }]}
          modelOptions={[
            {
              value: 'anthropic/claude-opus-4-8',
              label: 'claude-opus-4-8',
              provider: 'anthropic',
              providerLabel: 'Claude subscription',
              thinkingLevels: ['medium', 'high'],
            },
            {
              value: 'anthropic/claude-fable-5',
              label: 'claude-fable-5',
              provider: 'anthropic',
              providerLabel: 'Claude subscription',
              thinkingLevels: ['medium', 'high', 'xhigh', 'max'],
            },
          ]}
        />
      </div>
    );
  }

  try {
    await act(async () => root?.render(<Harness />));

    const modelTrigger = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('claude-opus-4-8'));
    assert.ok(modelTrigger, 'the selected agent-session model should render its trigger');
    await act(async () => modelTrigger.click());

    const fableButton = [...document.querySelectorAll<HTMLButtonElement>('.app-composer-model-menu-layer button')]
      .find((button) => button.textContent?.includes('claude-fable-5'));
    assert.ok(fableButton, 'Claude Fable 5 should be rendered in the portaled model menu');

    await act(async () => {
      fableButton.dispatchEvent(new installed.dom.window.MouseEvent('mousedown', { bubbles: true }));
    });
    assert.equal(fableButton.isConnected, true, 'mousedown inside the portal must not dismiss the model menu');

    await act(async () => fableButton.click());
    assert.equal(selectedModel, 'anthropic/claude-fable-5');
    assert.equal(document.querySelector('.app-composer-model-menu-layer'), null);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

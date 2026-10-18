import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setActiveChatRoute } from '../../src/features/chat/kordiCloudChatRoute';
import { setLocalAccountChoices } from '../../src/features/cloud/hostedAccountRegistry';
import { publishHostedProviderSnapshots } from '../../src/features/cloud/hostedAccounts';
import type { ComposerSelectorType, DesktopCollaborationHost } from '../../src/kordi-app/types';
import { CollaborationRoutingControls } from '../../src/pages/chatsPage.collaborationRoutingControls';
import { useChatCollaborationRouting } from '../../src/pages/useChatCollaborationRouting';
import '../../src/index.css';

// A synthetic Kordi Cloud agent session: the route's account may be removed,
// and every save takes a while and can fail, so the page shows whether picks
// apply at once and fall back to a usable account.
const params = new URLSearchParams(location.search);
const failSaves = params.has('fail');
const removedAccount = params.has('removed');
// Both account lists have arrived, so a missing account is truly gone.
if (params.has('loaded')) {
  setLocalAccountChoices([]);
  publishHostedProviderSnapshots([]);
}
const providers = [
  { value: 'openai-codex::cloud-login:work', providerId: 'openai-codex', label: 'Work', selectionLabel: 'ChatGPT • Work', active: true, hosted: true },
  { value: 'anthropic::cloud-login:research', providerId: 'anthropic', label: 'Research', selectionLabel: 'Claude • Research', hosted: true },
];
const models = [
  { value: 'openai-codex/gpt-6-sol', label: 'gpt-6-sol', provider: 'openai-codex', thinkingLevels: ['low', 'medium', 'high'] },
  { value: 'openai-codex/gpt-5.6-sol', label: 'gpt-5.6-sol', provider: 'openai-codex', thinkingLevels: ['low', 'medium', 'high', 'xhigh'] },
  { value: 'anthropic/claude-fable-5', label: 'claude-fable-5', provider: 'anthropic', thinkingLevels: ['high', 'max'] },
];
const initialRoute = {
  model: 'openai-codex/gpt-6-sol', thinking: 'medium', authProvider: 'openai-codex',
  authChoice: removedAccount ? 'cloud-login:removed' : 'cloud-login:work',
};
setActiveChatRoute(initialRoute);
const host = {
  id: 'cloud', displayName: 'Kordi', ownerName: 'Me', serverUrl: '', activeAgentId: 'agent',
  agents: [{ id: 'agent', label: 'My Kordi', runtime: 'local', isDefault: true, isActive: true, registered: true, ...initialRoute, defaultModel: initialRoute.model, defaultAuthProvider: initialRoute.authProvider, defaultAuthChoice: initialRoute.authChoice }],
} as unknown as DesktopCollaborationHost;

function Fixture() {
  const [route, setRoute] = useState(initialRoute);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [openSelector, setOpenSelector] = useState<{ scope: 'chat' | 'project'; type: ComposerSelectorType } | null>(null);
  const routing = useChatCollaborationRouting({
    shared: {
      desktopChatState: null, modelOptions: models, providerOptions: providers,
      updateRouting: (_host, _agent, model, _fallback, thinking, authProvider, authChoice) => {
        setPendingSaves((count) => count + 1);
        return new Promise<void>((resolve, reject) => window.setTimeout(() => {
          setPendingSaves((count) => count - 1);
          if (failSaves) { reject(new Error('Unable to save the model')); return; }
          const next = { model: model ?? route.model, thinking: thinking ?? route.thinking, authProvider: authProvider ?? route.authProvider, authChoice: authChoice ?? route.authChoice };
          setActiveChatRoute(next);
          setRoute(next);
          resolve();
        }, 1500));
      },
    },
    main: {
      conversation: { id: 'session:self-agent:preview', canonicalSessionId: 'session:self-agent:preview' } as never,
      host, enabled: true, isBusy: false, openSelector,
      toggleSelector: (_scope, type) => setOpenSelector((current) => current?.type === type ? null : { scope: 'chat', type }),
      composerSelection: route, selectComposerProviderChoice: () => undefined, selectComposerValue: () => undefined,
    },
    companion: { conversation: null, host: null, enabled: false, isBusy: false, openSelector: null, setOpenSelector: () => undefined },
  });
  const agent = routing.main.selectedAgent;
  return <main className="kordi-app theme-light" style={{ minHeight: '100vh', padding: 24, background: 'var(--utility-background)', color: 'var(--utility-foreground)' }}>
    <div data-pending-saves={pendingSaves} style={{ position: 'fixed', bottom: 24, left: 24, right: 24, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
      {routing.main.error ? <p role="alert" className="app-error-text text-[11px] text-rose-500">{routing.main.error}</p> : null}
      {agent ? <CollaborationRoutingControls
        model={{ agents: routing.main.agents, selectedAgent: agent, selection: routing.main.selection, visibility: routing.main.visibility }}
        menu={{ openSelector, agentSelectorOpen: false, compact: false }}
        onSignIn={() => undefined}
        options={{ authLabel: 'ChatGPT', authOptions: [], providerOptions: providers, modelOptions: models }}
        actions={{
          toggleSelector: (_scope, type) => setOpenSelector((current) => current?.type === type ? null : { scope: 'chat', type }),
          onSelectAgent: () => undefined, onUpdate: routing.main.update, defaultThinkingForModel: routing.main.defaultThinkingForModel,
        }}
      /> : null}
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

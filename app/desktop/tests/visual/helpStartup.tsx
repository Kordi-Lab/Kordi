import { useState } from 'react';
import { AppShellFrame } from '../../src/app/AppShellFrame';
import { useDesktopAuthUiState } from '../../src/features/auth/useDesktopAuthUiState';
import { cloudApiBaseUrl } from '../../src/features/cloud/authClient';
import { HelpEntry } from '../../src/features/onboarding/HelpEntry';
import { markHelpWelcome } from '../../src/features/onboarding/helpProgress';

const noop = () => {};

export function HelpStartupFixture() {
  const [loading, setLoading] = useState(() => {
    markHelpWelcome('local', cloudApiBaseUrl());
    return true;
  });
  const [connected, setConnected] = useState(false);
  const auth = useDesktopAuthUiState({
    isNativeShell: true, activeNav: 'contacts', activeSettingsSectionId: 'auth',
    desktopAuthState: { authPath: '', hasAnyAuth: connected, providers: [] },
    isDesktopAuthLoading: loading, startupGateSatisfied: connected,
    setActiveNav: noop, setActiveSettingsSectionId: noop,
    setActiveLoginProviderId: noop, clearDesktopAuthError: noop,
  });
  return <AppShellFrame
    rootThemeClass="theme-light" isNativeShell={false} isLayoutResizing={false}
    windowSize={{ width: 1000, height: 720 }} leftWorkspaceWidth={64}
    isSingleWorkspacePage showSessionRail={false} collapseChatSessions={false}
    showRightDetailRail={false} isDetailPanelCollapsed detailRailWidth={0}
    onSessionResizeMouseDown={noop} onDetailResizeMouseDown={noop}
    workspaceHelpAvailable={auth.workspaceHelpAvailable}
    sidebar={<aside style={{ paddingTop: 300 }}><HelpEntry activeNav="contacts" setActiveNav={noop} account={{}} onOpenSession={noop} /></aside>}
    mainContent={<section><h1>Main workspace</h1><button data-help-target="profile">Account</button></section>}
    authGate={loading ? <div className="app-auth-gate-overlay"><button onClick={() => setLoading(false)}>Finish loading providers</button></div>
      : auth.showAuthGate ? <div className="app-auth-gate-overlay"><h1>Connect a provider</h1><button onClick={auth.dismissAuthGate}>Skip for now</button><button onClick={() => setConnected(true)}>Connect test provider</button></div> : null}
  />;
}

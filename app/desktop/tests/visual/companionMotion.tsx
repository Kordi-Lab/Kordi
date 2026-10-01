import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShellFrame } from '../../src/app/AppShellFrame';
import { ChatCompanionLayout } from '../../src/pages/chatsPage.companionLayout';
import { CompanionToolbar } from '../../src/pages/chatsPage.companionToolbar';
import { useChatCompanionLayout } from '../../src/pages/useChatCompanionLayout';
import '../../src/index.css';

function Preview() {
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState('Unsent draft');
  const layout = useChatCompanionLayout({ pageConversationId: 'synthetic', activePaneKind: 'human', companionConversation: null, hasOverview: true });
  const { containerRef } = layout;
  return <AppShellFrame rootThemeClass="theme-dark" isNativeShell isLayoutResizing={false}
    windowSize={{ width: 996, height: 800 }} leftWorkspaceWidth={collapsed ? 48 : 296}
    isSingleWorkspacePage={false} showSessionRail collapseChatSessions={collapsed}
    showRightDetailRail={false} isDetailPanelCollapsed detailRailWidth={0}
    onSessionResizeMouseDown={() => {}} onDetailResizeMouseDown={() => {}}
    onToggleSessionPanel={() => setCollapsed(value => !value)}
    sidebar={<aside className="app-workspace-sidebar app-side-shell overflow-hidden"><div className="flex h-full">
      <nav style={{ width: 48, flexShrink: 0 }}>Chats</nav>
      <div className="app-session-panel-clip min-w-0 flex-1 overflow-hidden"><div className="app-session-panel" style={{ width: 248 }} inert={collapsed}>Synthetic sessions</div></div>
    </div></aside>}
    mainContent={<ChatCompanionLayout containerRef={containerRef} layout={layout} view="chat"
      companionPane={<aside className="h-full"><textarea aria-label="Agent draft" value={draft} onChange={event => setDraft(event.target.value)} className="w-full" /></aside>}>
      <section className="app-chat-main-workspace min-w-0 overflow-hidden">
        <CompanionToolbar view="chat" isOpen={layout.isVisible} hasChat canOpenChat onSelect={() => layout.setFolded(false)} onHide={() => layout.setFolded(true)} />
        <button onClick={() => layout.placeCompanion(layout.side === 'right' ? 'left' : 'right')}>Move panel</button>
        <textarea aria-label="Main draft" className="w-full" />
      </section>
    </ChatCompanionLayout>} />;
}
createRoot(document.getElementById('root')!).render(<Preview />);

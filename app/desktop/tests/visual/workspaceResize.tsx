import { createRoot } from 'react-dom/client';
import { AppShellFrame } from '../../src/app/AppShellFrame';
import { ChatPaneLayout } from '../../src/pages/ChatPaneLayout';
import { mockIPC } from '@tauri-apps/api/mocks';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'theme-dark' : 'theme-light';
document.documentElement.classList.add('kordi-native-shell');
document.body.classList.add('kordi-native-shell', theme);
document.body.dataset.kordiChatTheme = 'quiet';
if (params.has('backdrop')) {
  const requests: unknown[] = [];
  Object.assign(window, { backdropRequests: requests });
  mockIPC((command, args) => {
    if (command === 'desktop_set_window_backdrop') {
      requests.push(args);
      if (params.has('backdropFail')) return Promise.reject(new Error('Native backdrop unavailable'));
    }
  });
}
const noop = () => {};
// Cross several line boundaries at both test widths instead of depending on a
// short paragraph gaining one line with a particular browser's font metrics.
const resizeMessage = 'The available message width changes with the window, while text and icons retain their original dimensions and the composer remains at the bottom of the chat column. '.repeat(3);
createRoot(document.getElementById('root')!).render(
  <div className="app-cloud-workspace-surface">
  <AppShellFrame
    rootThemeClass={theme} isNativeShell isLayoutResizing={false}
    windowSize={{ width: 1480, height: 980 }} leftWorkspaceWidth={320}
    isSingleWorkspacePage={false} showSessionRail collapseChatSessions={false}
    showRightDetailRail={false} isDetailPanelCollapsed detailRailWidth={0}
    onSessionResizeMouseDown={noop} onDetailResizeMouseDown={noop}
    sidebar={<aside className="app-side-shell flex min-h-0 overflow-hidden">
      <nav style={{ width: 72, flexShrink: 0 }} aria-label="Navigation">Chats</nav>
      <div className="app-session-panel min-w-0 flex-1 overflow-y-auto">Test conversation</div>
    </aside>}
    mainContent={<ChatPaneLayout hasHeader>
      <header className="app-page-header app-chat-pane-header flex shrink-0 items-center justify-between">
        <h2 style={{ fontSize: 17 }}>Layout regression conversation</h2>
        <svg data-testid="fixed-icon" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor" /></svg>
      </header>
      <div className="app-chat-theme-surface flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div data-testid="messages" className="app-scroll-area min-h-0 min-w-0 flex-1 overflow-y-auto px-5">
          {Array.from({ length: 80 }, (_, index) => <p key={index} style={{ fontSize: 15, lineHeight: '24px', maxWidth: '80%' }}>
            Synthetic message {index + 1}. {resizeMessage}
          </p>)}
        </div>
        <div data-testid="composer" className="shrink-0 px-5 pb-4 pt-3">
          <textarea aria-label="Message" className="app-composer-shell block w-full resize-none" style={{ fontSize: 15 }} defaultValue="Draft stays editable during resizing" />
        </div>
      </div>
    </ChatPaneLayout>}
  />
  </div>,
);

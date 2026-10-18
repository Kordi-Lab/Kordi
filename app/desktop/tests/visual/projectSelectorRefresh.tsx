import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatWorkspaceControls } from '../../src/features/projects/ChatWorkspaceControls';
import { ChatProjectsContext, canChooseChatProject, type ChatProject } from '../../src/features/projects/chatProjects';
import type { GitWorkspace } from '../../src/features/projects/gitWorkspace';
import { cloudChatId, desktopState, localChatId, refreshes, selectedFor } from '../helpers/cloudChatRuntimeCopyFixtures';
import '../../src/index.css';

// Each refresh replays the runtime state the Mac reports while it opens and runs a chat.
const projects: ChatProject[] = [{ id: 'website', name: 'website', root: '/fixture/website', sessions: [{ id: localChatId }] }];
const gitWorkspace = async (root: string): Promise<GitWorkspace> => ({ branch: 'main', branches: ['main'], worktrees: [{ path: root, branch: 'main' }], workspaceRoot: root, isWorktree: false });

function Fixture() {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const sessionId = params.get('chat') === 'local' ? localChatId : cloudChatId;
  const [refresh, setRefresh] = useState(0);
  const conversation = selectedFor(sessionId, desktopState(refreshes[refresh % refreshes.length]));
  return <main className={`kordi-app theme-${theme}`} data-refresh={refresh} style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--utility-background)', color: 'var(--utility-foreground)' }}>
    <ChatProjectsContext value={{ enabled: true, projects, gitWorkspace, assign: async () => {}, create: async () => {} }}>
      <div style={{ flex: 1, padding: '24px 20px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
      </div>
      <div className="app-chat-composer-frame shrink-0 px-5 pb-4 pt-3">
        {canChooseChatProject(conversation) ? <ChatWorkspaceControls key={conversation.id} conversation={conversation} disabled={false} /> : null}
        <div className="app-composer-input rounded-[18px] px-4" data-composer-input style={{ minHeight: 88, border: '1px solid var(--app-divider)' }}>
          <textarea aria-label="Ask your agent…" placeholder="Ask your agent…" style={{ width: '100%', minHeight: 56, resize: 'none', outline: 'none', background: 'transparent' }} />
        </div>
      </div>
    </ChatProjectsContext>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

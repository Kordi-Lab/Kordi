import { createRoot } from 'react-dom/client';
import { ChatWorkspaceControls } from '../../src/features/projects/ChatWorkspaceControls';
import { ChatProjectsContext, type ChatProjects } from '../../src/features/projects/chatProjects';
import type { GitWorkspace } from '../../src/features/projects/gitWorkspace';
import type { Conversation } from '../../src/kordi-app/types';
import '../../src/index.css';

const branches: Record<string, string> = {
  '/fixture/sample-app': 'design/sample-feature-with-a-long-branch-name',
  '/fixture/sample-research-workspace-with-a-long-name': 'main',
};
const projects: ChatProjects = {
  enabled: true,
  projects: [
    { id: 'short', name: 'sample-app', root: '/fixture/sample-app', sessions: [{ id: 'chat-short' }] },
    { id: 'long', name: 'sample-research-workspace-with-a-long-name', root: '/fixture/sample-research-workspace-with-a-long-name', sessions: [{ id: 'chat-long' }] },
  ],
  gitWorkspace: async (root): Promise<GitWorkspace> => ({
    branch: branches[root] ?? 'main', branches: ['main'], worktrees: [{ path: root, branch: branches[root] ?? 'main' }], workspaceRoot: root, isWorktree: false,
  }),
  openImporter: () => {},
  assign: async () => {},
  create: async () => {},
};
const conversation = (id: string) => ({ id, localSessionCwd: null }) as unknown as Conversation;
const params = new URLSearchParams(location.search);
const theme = params.get('theme') ?? 'light';
const widths = (params.get('widths') ?? '360,480,640,900').split(',').map(Number);

function Fixture() {
  return <main className={`kordi-app theme-${theme}`} style={{ minHeight: '100vh', padding: 16, background: 'var(--utility-background)', color: 'var(--utility-foreground)' }}>
    <ChatProjectsContext value={projects}>
      {widths.flatMap((width) => ['chat-short', 'chat-long'].map((id) => (
        <section key={`${width}-${id}`} data-testid={`row-${width}-${id}`} style={{ width, marginBottom: 12, border: '1px dashed var(--app-divider)' }}>
          <div className="app-chat-composer-frame px-5 pb-4 pt-3">
            <ChatWorkspaceControls conversation={conversation(id)} disabled={false} />
            <div className="app-composer-shell rounded-[24px] p-3" style={{ minHeight: 56 }} />
          </div>
        </section>
      )))}
    </ChatProjectsContext>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

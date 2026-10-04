import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatProjectPicker } from '../../src/features/projects/ChatProjectPicker';
import { ChatProjectsContext, type ChatProject } from '../../src/features/projects/chatProjects';
import '../../src/index.css';

function Fixture() {
  const [projects, setProjects] = useState<ChatProject[]>([
    { id: 'kordi', name: 'kordi', root: '/fixture/kordi', sessions: [] },
    { id: 'design', name: 'Design research', root: '/fixture/design', sessions: [] },
  ]);
  const theme = new URLSearchParams(location.search).get('theme') ?? 'light';
  const assign = async (sessionId: string, root: string) => {
    setProjects((current) => current.map((project) => ({ ...project,
      sessions: project.root === root ? [{ id: sessionId }] : [],
    })));
  };
  return <main className={`kordi-app theme-${theme}`} style={{ minHeight: '100vh', padding: 24, background: 'var(--utility-background)', color: 'var(--utility-foreground)' }}>
    <ChatProjectsContext value={{ enabled: true, projects, assign, create: async (sessionId, name, folder) => {
      if (folder === 'missing') throw new Error('Project folder does not exist');
      setProjects((current) => [...current.map((project) => ({ ...project, sessions: [] })),
        { id: name, name, root: folder || `/fixture/${name}`, sessions: [{ id: sessionId }] }]);
    } }}>
      <div style={{ position: 'fixed', bottom: 24, left: 24, right: 24, maxWidth: 620 }}>
        <div style={{ border: '1px solid var(--app-divider)', borderRadius: 20, padding: 16, marginBottom: 8 }}>
          <textarea aria-label="Message" placeholder="Ask Kordi to work on something" style={{ width: '100%', minHeight: 56, resize: 'none', outline: 'none' }} />
        </div>
        <ChatProjectPicker sessionId="session-one" />
        <button type="button" style={{ marginLeft: 16 }} aria-label="Outside action">Outside</button>
      </div>
    </ChatProjectsContext>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

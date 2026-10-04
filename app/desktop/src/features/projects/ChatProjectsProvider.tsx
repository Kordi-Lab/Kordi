import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ChatProjectsContext, type ChatProjects } from './chatProjects';
import { ProjectImportDialog } from './ProjectImportDialog';

export function ChatProjectsProvider({ value, children }: { value: ChatProjects; children: ReactNode }) {
  const [importTarget, setImportTarget] = useState<{ sessionId: string } | null>(null);
  const openImporter = useCallback((sessionId = '') => setImportTarget({ sessionId }), []);
  const context = useMemo(() => ({ ...value, openImporter }), [value, openImporter]);
  return <ChatProjectsContext value={context}>
    {children}
    {importTarget ? <ProjectImportDialog onClose={() => setImportTarget(null)} onImported={async (project) => {
      await value.assign(importTarget.sessionId, project.root);
    }} /> : null}
  </ChatProjectsContext>;
}

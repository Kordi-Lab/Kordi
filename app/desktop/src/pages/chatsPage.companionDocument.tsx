import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import type { CompanionDocument } from '@/features/documents/companionDocument';
import { CompanionDocumentTabs } from '@/features/documents/CompanionDocumentTabs';
import { companionDocumentTabIds } from '@/features/documents/companionTabsState';
import { DocumentReader } from '@/features/documents/DocumentReader';
import { DocumentReaderHostContext, type DocumentReaderHost } from '@/features/documents/documentReaderHost';
import type { DocumentShareApi } from '@/features/documents/documentShareApi';
import { dispatchDocumentSessionOpen } from '@/features/documents/documentShareToken';
import type { CompanionDocumentTabsModel } from '@/features/documents/useCompanionDocument';
import type { DesktopArtifactPreview } from '@/kordi-app/types';
import { fetchDesktopChatArtifactPreview, isNativeDesktopShell } from '@/lib/desktop';
import { CompanionTitlebar } from './CompanionTitlebar';

type LoadedPreview = { key: string; preview: DesktopArtifactPreview | null };

/** One open document: its reader, fed from the file on this Mac when there is one. */
function CompanionDocumentReader({ document, api, onTitle, onRenameAvailable }: {
  document: CompanionDocument;
  api?: DocumentShareApi;
  onTitle: (id: string, title: string) => void;
  onRenameAvailable: (id: string, rename: ((title: string) => void) | null) => void;
}) {
  const { artifact } = document;
  const [reloads, setReloads] = useState(0);
  const key = `${document.previewBaseRoot ?? ''}:${artifact.id}:${artifact.path}`;
  const canReadLocally = !document.preview && isNativeDesktopShell();
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null);
  useEffect(() => {
    if (!canReadLocally) return undefined;
    let cancelled = false;
    fetchDesktopChatArtifactPreview(artifact.path, document.previewBaseRoot ?? null)
      .then((preview) => { if (!cancelled) setLoaded({ key, preview }); })
      .catch(() => { if (!cancelled) setLoaded({ key, preview: null }); });
    return () => { cancelled = true; };
  }, [artifact.path, canReadLocally, document.previewBaseRoot, key, reloads]);
  const reportTitle = useCallback((title: string) => onTitle(artifact.id, title), [artifact.id, onTitle]);
  const reportRename = useCallback((rename: ((title: string) => void) | null) => onRenameAvailable(artifact.id, rename), [artifact.id, onRenameAvailable]);
  const reload = useCallback(() => setReloads((count) => count + 1), []);

  const preview = document.preview ?? (loaded?.key === key ? loaded.preview : null);
  const waitingForFile = canReadLocally && loaded?.key !== key && !artifact.attachmentId;
  const localSource = preview ? preview.lines.map((line) => line.text).join('\n') : null;

  if (waitingForFile) return <p className="app-companion-status" role="status"><LoaderCircle className="inline h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Loading</p>;
  return (
    <DocumentReader
      api={api}
      className="app-document-reader-pane"
      path={artifact.path}
      attachmentId={artifact.attachmentId ?? null}
      localSource={localSource}
      dateLabel={artifact.timeLabel ?? null}
      onOpenSession={dispatchDocumentSessionOpen}
      onTitle={reportTitle}
      onRenameAvailable={reportRename}
      onReload={reload}
    />
  );
}

/**
 * The chat companion pane's documents: a tab strip and one reader per open
 * document. Readers of inactive tabs stay mounted (and hidden), so scroll
 * position, unsaved edits and the collaboration room survive a tab switch.
 * Closing the last tab, like hiding the pane, closes it.
 */
export function CompanionDocumentPane({ tabs, host, onClose, api }: {
  tabs: Pick<CompanionDocumentTabsModel, 'documents' | 'activeId' | 'activate' | 'closeTab'>;
  host: DocumentReaderHost;
  onClose: () => void;
  api?: DocumentShareApi;
}) {
  const { documents, activeId } = tabs;
  const [titles, setTitles] = useState<Record<string, string>>({});
  const setTitle = useCallback((id: string, title: string) => {
    setTitles((current) => (current[id] === title ? current : { ...current, [id]: title }));
  }, []);
  const [renames, setRenames] = useState<Record<string, (title: string) => void>>({});
  const setRename = useCallback((id: string, rename: ((title: string) => void) | null) => {
    setRenames((current) => {
      if ((current[id] ?? null) === rename) return current;
      const next = { ...current };
      if (rename) next[id] = rename;
      else delete next[id];
      return next;
    });
  }, []);
  const closeTab = (id: string) => (documents.length <= 1 ? onClose() : tabs.closeTab(id));

  return <aside className="app-companion-overview app-companion-document" aria-label="Document panel">
    <CompanionTitlebar>
      <CompanionDocumentTabs documents={documents} activeId={activeId} titles={titles} renames={renames} onActivate={tabs.activate} onCloseTab={closeTab} onHide={onClose} />
    </CompanionTitlebar>
    <DocumentReaderHostContext.Provider value={host}>
      <div className="app-companion-document-panels">
        {documents.map((document) => {
          const ids = companionDocumentTabIds(document.artifact.id);
          return (
            <div key={document.artifact.id} id={ids.panel} className="app-companion-document-panel" role="tabpanel" aria-labelledby={ids.tab} hidden={document.artifact.id !== activeId}>
              <CompanionDocumentReader document={document} api={api} onTitle={setTitle} onRenameAvailable={setRename} />
            </div>
          );
        })}
      </div>
    </DocumentReaderHostContext.Provider>
  </aside>;
}

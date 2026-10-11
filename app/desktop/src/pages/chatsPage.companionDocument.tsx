import { useEffect, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';

import type { CompanionDocument } from '@/features/documents/companionDocument';
import { DocumentReader } from '@/features/documents/DocumentReader';
import { DocumentReaderHostContext, type DocumentReaderHost } from '@/features/documents/documentReaderHost';
import type { DocumentShareApi } from '@/features/documents/documentShareApi';
import { dispatchDocumentSessionOpen } from '@/features/documents/documentShareToken';
import type { DesktopArtifactPreview } from '@/kordi-app/types';
import { fetchDesktopChatArtifactPreview, isNativeDesktopShell } from '@/lib/desktop';
import { CompanionTitlebar } from './CompanionTitlebar';

type LoadedPreview = { key: string; preview: DesktopArtifactPreview | null };

/** The document reader in the chat companion pane. Hiding the pane closes the document. */
export function CompanionDocumentPane({ document, host, onClose, api }: {
  document: CompanionDocument;
  host: DocumentReaderHost;
  onClose: () => void;
  api?: DocumentShareApi;
}) {
  const { artifact } = document;
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
  }, [artifact.path, canReadLocally, document.previewBaseRoot, key]);

  const preview = document.preview ?? (loaded?.key === key ? loaded.preview : null);
  const waitingForFile = canReadLocally && loaded?.key !== key && !artifact.attachmentId;
  const localSource = preview ? preview.lines.map((line) => line.text).join('\n') : null;

  return <aside className="app-companion-overview app-companion-document" aria-label="Document panel">
    <CompanionTitlebar>
      <header className="app-page-header app-chat-pane-header app-companion-overview-header">
        <div><h2>Document</h2></div>
        <button type="button" aria-label="Hide panel" title="Hide panel" onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </header>
    </CompanionTitlebar>
    {waitingForFile ? <p className="app-companion-status" role="status"><LoaderCircle className="inline h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Loading</p> : (
      <DocumentReaderHostContext.Provider value={host}>
        <DocumentReader
          key={artifact.id}
          api={api}
          className="app-document-reader-pane"
          path={artifact.path}
          attachmentId={artifact.attachmentId ?? null}
          localSource={localSource}
          dateLabel={artifact.timeLabel ?? null}
          onOpenSession={dispatchDocumentSessionOpen}
        />
      </DocumentReaderHostContext.Provider>
    )}
  </aside>;
}

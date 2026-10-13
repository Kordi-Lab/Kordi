import type { DesktopArtifactPreview, SessionArtifact } from '@/kordi-app/types';

import { dispatchDocumentSessionOpen } from './documentShareToken';
import { DocumentReader } from './DocumentReader';

export function ArtifactDocumentSection({ artifact, preview }: { artifact: SessionArtifact; preview: DesktopArtifactPreview | null }) {
  return (
    <section data-artifact-preview-section="true" className="app-detail-section flex min-h-0 flex-1 flex-col border-t border-[color:var(--app-divider)] pt-[18px] pb-0">
      <DocumentReader
        path={artifact.path}
        attachmentId={artifact.attachmentId ?? null}
        localSource={preview ? preview.lines.map((line) => line.text).join('\n') : null}
        dateLabel={artifact.timeLabel ?? null}
        onOpenSession={dispatchDocumentSessionOpen}
      />
    </section>
  );
}

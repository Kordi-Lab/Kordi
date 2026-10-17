import type { ReactNode } from 'react';

import { ErrorBoundary } from '@/components/ErrorBoundary';

/**
 * The document area when its editor fails: one line and the Markdown as plain
 * text, so the document can still be read. Resets when `resetKey` changes
 * (another document, a new revision).
 */
export function DocumentErrorBoundary({ resetKey, blocks, children }: {
  resetKey: string;
  blocks: readonly { source: string }[];
  children: ReactNode;
}) {
  return (
    <ErrorBoundary
      area="documents"
      resetKey={resetKey}
      fallback={() => (
        <div className="app-document-fallback" role="alert">
          <p className="app-document-fallback-note">Couldn't open the editor. Showing the text.</p>
          <pre className="app-document-fallback-source">{blocks.map((block) => block.source).join('\n\n')}</pre>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
